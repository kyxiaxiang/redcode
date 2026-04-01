/**
 * cursor-client.ts - Cursor API 客户端
 *
 * 职责：
 * 1. 发送请求到 https://cursor.com/api/chat（带 Chrome TLS 指纹模拟 headers）
 * 2. 流式解析 SSE 响应
 * 3. 自动重试（最多 2 次）
 *
 * 注：x-is-human token 验证已被 Cursor 停用，直接发送空字符串即可。
 */

import type { CursorChatRequest, CursorSSEEvent } from './types.js';
import { getConfig } from './config.js';
import { getProxyFetchOptions } from './proxy-agent.js';

const CURSOR_CHAT_API = 'https://cursor.com/api/chat';

// Chrome 浏览器请求头模拟
function getChromeHeaders(): Record<string, string> {
    const config = getConfig();
    return {
        'Content-Type': 'application/json',
        'sec-ch-ua-platform': '"Windows"',
        'x-path': '/api/chat',
        'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
        'x-method': 'POST',
        'sec-ch-ua-bitness': '"64"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-arch': '"x86"',
        'sec-ch-ua-platform-version': '"19.0.0"',
        'origin': 'https://cursor.com',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'referer': 'https://cursor.com/',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'priority': 'u=1, i',
        'user-agent': config.fingerprint.userAgent,
        'x-is-human': '',  // Cursor 不再校验此字段
    };
}

// ==================== API 请求 ====================

/**
 * 发送请求到 Cursor /api/chat 并以流式方式处理响应（带重试）
 */
export async function sendCursorRequest(
    req: CursorChatRequest,
    onChunk: (event: CursorSSEEvent) => void,
    externalSignal?: AbortSignal,
): Promise<void> {
    const maxRetries = 2;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await sendCursorRequestInner(req, onChunk, externalSignal);
            return;
        } catch (err) {
            // 外部主动中止不重试
            if (externalSignal?.aborted) throw err;
            // ★ 退化循环中止不重试 — 已有的内容是有效的，重试也会重蹈覆辙
            if (err instanceof Error && err.message === 'DEGENERATE_LOOP_ABORTED') return;
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[Cursor] 请求失败 (${attempt}/${maxRetries}): ${msg.substring(0, 100)}`);
            if (attempt < maxRetries) {
                await new Promise(r => setTimeout(r, 2000));
            } else {
                throw err;
            }
        }
    }
}

async function sendCursorRequestInner(
    req: CursorChatRequest,
    onChunk: (event: CursorSSEEvent) => void,
    externalSignal?: AbortSignal,
): Promise<void> {
    const headers = getChromeHeaders();

    // 详细日志记录在 handler 层

    const config = getConfig();
    const controller = new AbortController();
    // 链接外部信号：外部中止时同步中止内部 controller
    if (externalSignal) {
        if (externalSignal.aborted) { controller.abort(); }
        else { externalSignal.addEventListener('abort', () => controller.abort(), { once: true }); }
    }

    // ★ 空闲超时（Idle Timeout）：用读取活动检测替换固定总时长超时。
    // 每次收到新数据时重置计时器，只有在指定时间内完全无数据到达时才中断。
    // 这样长输出（如写长文章、大量工具调用）不会因总时长超限被误杀。
    const IDLE_TIMEOUT_MS = config.timeout * 1000; // 复用 timeout 配置作为空闲超时阈值
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            console.warn(`[Cursor] 空闲超时（${config.timeout}s 无新数据），中止请求`);
            controller.abort();
        }, IDLE_TIMEOUT_MS);
    };

    // 启动初始计时（等待服务器开始响应）
    resetIdleTimer();

    try {
        const resp = await fetch(CURSOR_CHAT_API, {
            method: 'POST',
            headers,
            body: JSON.stringify(req),
            signal: controller.signal,
            ...getProxyFetchOptions(),
        } as any);

        if (!resp.ok) {
            const body = await resp.text();
            throw new Error(`Cursor API 错误: HTTP ${resp.status} - ${body}`);
        }

        if (!resp.body) {
            throw new Error('Cursor API 响应无 body');
        }

        // 流式读取 SSE 响应
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        // ★ 退化重复检测器 (#66)
        // 模型有时会陷入循环，不断输出 </s>、</br> 等无意义标记
        // 检测原理：跟踪最近的连续相同 delta，超过阈值则中止流
        let lastDelta = '';
        let repeatCount = 0;
        const REPEAT_THRESHOLD = 8;       // 同一 delta 连续出现 8 次 → 退化
        let degenerateAborted = false;

        // ★ HTML token 重复检测：历史消息较多时模型偶发连续输出 <br>、</s> 等 HTML token 的 bug
        // 用 tagBuffer 跨 delta 拼接，提取完整 token 后检测连续重复，不依赖换行
        let tagBuffer = '';
        let htmlRepeatAborted = false;
        const HTML_TOKEN_RE = /(<\/?[a-z][a-z0-9]*\s*\/?>|&[a-z]+;)/gi;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            // 每次收到数据就重置空闲计时器
            resetIdleTimer();

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (!data) continue;

                try {
                    const event: CursorSSEEvent = JSON.parse(data);

                    // ★ 退化重复检测：当模型重复输出同一短文本片段时中止
                    if (event.type === 'text-delta' && event.delta) {
                        const trimmedDelta = event.delta.trim();
                        // 只检测短 token（长文本重复是正常的，比如重复的代码行）
                        if (trimmedDelta.length > 0 && trimmedDelta.length <= 20) {
                            if (trimmedDelta === lastDelta) {
                                repeatCount++;
                                if (repeatCount >= REPEAT_THRESHOLD) {
                                    console.warn(`[Cursor] ⚠️ 检测到退化循环: "${trimmedDelta}" 已连续重复 ${repeatCount} 次，中止流`);
                                    degenerateAborted = true;
                                    reader.cancel();
                                    break;
                                }
                            } else {
                                lastDelta = trimmedDelta;
                                repeatCount = 1;
                            }
                        } else {
                            // 长文本或空白 → 重置计数
                            lastDelta = '';
                            repeatCount = 0;
                        }

                        // ★ HTML token 重复检测：跨 delta 拼接，提取完整 HTML token 后检测连续重复
                        // 解决 <br>、</s>、&nbsp; 等被拆散发送或无换行导致退化检测失效的 bug
                        tagBuffer += event.delta;
                        const tagMatches = [...tagBuffer.matchAll(new RegExp(HTML_TOKEN_RE.source, 'gi'))];
                        if (tagMatches.length > 0) {
                            const lastTagMatch = tagMatches[tagMatches.length - 1];
                            tagBuffer = tagBuffer.slice(lastTagMatch.index! + lastTagMatch[0].length);
                            for (const m of tagMatches) {
                                const token = m[0].toLowerCase();
                                if (token === lastDelta) {
                                    repeatCount++;
                                    if (repeatCount >= REPEAT_THRESHOLD) {
                                        console.warn(`[Cursor] ⚠️ 检测到 HTML token 重复: "${token}" 已连续重复 ${repeatCount} 次，中止流`);
                                        htmlRepeatAborted = true;
                                        reader.cancel();
                                        break;
                                    }
                                } else {
                                    lastDelta = token;
                                    repeatCount = 1;
                                }
                            }
                            if (htmlRepeatAborted) break;
                        } else if (tagBuffer.length > 20) {
                            // 超过 20 字符还没有完整 HTML token，不是 HTML 序列，清空避免内存累积
                            tagBuffer = '';
                        }
                    }

                    onChunk(event);
                } catch {
                    // 非 JSON 数据，忽略
                }
            }

            if (degenerateAborted || htmlRepeatAborted) break;
        }

        // ★ 退化循环中止后，抛出特殊错误让外层 sendCursorRequest 不再重试
        if (degenerateAborted) {
            throw new Error('DEGENERATE_LOOP_ABORTED');
        }
        // ★ HTML token 重复中止后，抛出普通错误让外层 sendCursorRequest 走正常重试
        if (htmlRepeatAborted) {
            throw new Error('HTML_REPEAT_ABORTED');
        }

        // 处理剩余 buffer
        if (buffer.startsWith('data: ')) {
            const data = buffer.slice(6).trim();
            if (data) {
                try {
                    const event: CursorSSEEvent = JSON.parse(data);
                    onChunk(event);
                } catch { /* ignore */ }
            }
        }
    } finally {
        if (idleTimer) clearTimeout(idleTimer);
    }
}

/**
 * 发送非流式请求，收集完整响应及 usage 信息
 */
export async function sendCursorRequestFull(req: CursorChatRequest): Promise<{ text: string; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }> {
    let fullText = '';
    let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
    await sendCursorRequest(req, (event) => {
        if (event.type === 'text-delta' && event.delta) {
            fullText += event.delta;
        }
        if (event.messageMetadata?.usage) {
            usage = event.messageMetadata.usage;
        }
    });
    return { text: fullText, usage };
}
