/**
 * streaming-text.ts - 流式文本增量释放辅助
 *
 * 目标：
 * 1. 为纯正文流提供更接近“打字效果”的增量输出
 * 2. 在真正开始向客户端输出前，先保留一小段预热文本，降低拒绝前缀泄漏概率
 * 3. 发送时保留尾部保护窗口，给跨 chunk 的清洗规则预留上下文
 */

export interface LeadingThinkingSplit {
    startedWithThinking: boolean;
    complete: boolean;
    thinkingContent: string;
    remainder: string;
}

export interface IncrementalTextStreamerOptions {
    warmupChars?: number;
    guardChars?: number;
    transform?: (text: string) => string;
    isBlockedPrefix?: (text: string) => boolean;
}

export interface IncrementalTextStreamer {
    push(chunk: string): string;
    finish(): string;
    hasUnlocked(): boolean;
    hasSentText(): boolean;
    getRawText(): string;
}

const THINKING_OPEN = '<thinking>';
const THINKING_CLOSE = '</thinking>';
const DEFAULT_WARMUP_CHARS = 96;
const DEFAULT_GUARD_CHARS = 256;
const STREAM_START_BOUNDARY_RE = /[\n。！？.!?]/;
const HTML_TOKEN_STRIP_RE = /(<\/?[a-z][a-z0-9]*\s*\/?>|&[a-z]+;)/gi;
const HTML_VALID_RATIO_MIN = 0.2;   // 去掉 HTML token 后有效字符占比低于此值则继续缓冲

/**
 * 剥离完整的 thinking 标签，返回可用于拒绝检测或最终文本处理的正文。
 *
 * ★ 使用 indexOf + lastIndexOf 而非非贪婪正则，防止 thinking 内容本身
 *   包含 </thinking> 字面量时提前截断导致标签泄漏到正文。
 */
export function stripThinkingTags(text: string): string {
    if (!text || !text.includes(THINKING_OPEN)) return text;
    const startIdx = text.indexOf(THINKING_OPEN);
    const endIdx = text.lastIndexOf(THINKING_CLOSE);
    if (endIdx > startIdx) {
        return (text.slice(0, startIdx) + text.slice(endIdx + THINKING_CLOSE.length)).trim();
    }
    // 未闭合（流式截断）→ 剥离从 <thinking> 开始的全部内容
    return text.slice(0, startIdx).trim();
}

/**
 * 检测文本是否以 <thinking> 开头（允许前导空白）。
 *
 * ★ 修复 Issue #64：用位置约束替代宽松的 includes('<thinking>')，
 *   防止用户消息或模型正文中的字面量 <thinking> 误触发 extractThinking，
 *   导致正文内容被错误截断或丢失。
 */
export function hasLeadingThinking(text: string): boolean {
    if (!text) return false;
    return /^\s*<thinking>/.test(text);
}

/**
 * 只解析“前导 thinking 块”。
 *
 * Cursor 的 thinking 通常位于响应最前面，正文随后出现。
 * 这里仅处理前导块，避免把正文中的普通文本误判成 thinking 标签。
 */
export function splitLeadingThinkingBlocks(text: string): LeadingThinkingSplit {
    if (!text) {
        return {
            startedWithThinking: false,
            complete: false,
            thinkingContent: '',
            remainder: '',
        };
    }

    const trimmed = text.trimStart();
    if (!trimmed.startsWith(THINKING_OPEN)) {
        return {
            startedWithThinking: false,
            complete: false,
            thinkingContent: '',
            remainder: text,
        };
    }

    let cursor = trimmed;
    const thinkingParts: string[] = [];

    while (cursor.startsWith(THINKING_OPEN)) {
        const closeIndex = cursor.indexOf(THINKING_CLOSE, THINKING_OPEN.length);
        if (closeIndex === -1) {
            // ★ 未闭合（截断）：返回截断前已积累的部分 thinking 内容
            // 当前未闭合块的内容 + 前面已完整的块（如有多个连续 thinking 块的情况）
            const partialContent = cursor.slice(THINKING_OPEN.length).trim();
            const allParts = [...thinkingParts, ...(partialContent ? [partialContent] : [])];
            return {
                startedWithThinking: true,
                complete: false,
                thinkingContent: allParts.join('\n\n'),
                remainder: '',
            };
        }

        const content = cursor.slice(THINKING_OPEN.length, closeIndex).trim();
        if (content) thinkingParts.push(content);
        cursor = cursor.slice(closeIndex + THINKING_CLOSE.length).trimStart();
    }

    return {
        startedWithThinking: true,
        complete: true,
        thinkingContent: thinkingParts.join('\n\n'),
        remainder: cursor,
    };
}

/**
 * 创建增量文本释放器。
 *
 * 释放策略：
 * - 先缓冲一小段，确认不像拒绝前缀，再开始输出
 * - 输出时总是保留尾部 guardChars，不把“边界附近”的文本过早发出去
 * - 最终 finish() 时再把剩余文本一次性补齐
 */
export function createIncrementalTextStreamer(
    options: IncrementalTextStreamerOptions = {},
): IncrementalTextStreamer {
    const warmupChars = options.warmupChars ?? DEFAULT_WARMUP_CHARS;
    const guardChars = options.guardChars ?? DEFAULT_GUARD_CHARS;
    const transform = options.transform ?? ((text: string) => text);
    const isBlockedPrefix = options.isBlockedPrefix ?? (() => false);

    let rawText = '';
    let sentText = '';
    let unlocked = false;
    let sentAny = false;

    const tryUnlock = (): boolean => {
        if (unlocked) return true;

        const preview = transform(rawText);
        if (!preview.trim()) return false;

        const hasBoundary = STREAM_START_BOUNDARY_RE.test(preview);
        const enoughChars = preview.length >= warmupChars;
        if (!hasBoundary && !enoughChars) {
            return false;
        }

        if (isBlockedPrefix(preview.trim())) {
            return false;
        }

        // ★ HTML 内容有效性检查：防止 <br>、</s>、&nbsp; 等纯 HTML token 连续重复时提前 unlock
        // 超过 guardChars（256）后强制放行，此时 cursor-client 的 htmlRepeatAborted 早已触发重试
        if (preview.length < guardChars) {
            const noSpace = preview.replace(/\s/g, '');
            const stripped = noSpace.replace(HTML_TOKEN_STRIP_RE, '');
            const ratio = noSpace.length === 0 ? 0 : stripped.length / noSpace.length;
            if (ratio < HTML_VALID_RATIO_MIN) {
                return false;
            }
        }

        unlocked = true;
        return true;
    };

    const emitFromRawLength = (rawLength: number): string => {
        const transformed = transform(rawText.slice(0, rawLength));
        if (transformed.length <= sentText.length) return '';

        const delta = transformed.slice(sentText.length);
        sentText = transformed;
        if (delta) sentAny = true;
        return delta;
    };

    return {
        push(chunk: string): string {
            if (!chunk) return '';

            rawText += chunk;
            if (!tryUnlock()) return '';

            const safeRawLength = Math.max(0, rawText.length - guardChars);
            if (safeRawLength <= 0) return '';

            return emitFromRawLength(safeRawLength);
        },

        finish(): string {
            if (!rawText) return '';
            return emitFromRawLength(rawText.length);
        },

        hasUnlocked(): boolean {
            return unlocked;
        },

        hasSentText(): boolean {
            return sentAny;
        },

        getRawText(): string {
            return rawText;
        },
    };
}
