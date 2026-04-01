/**
 * logger.ts - 全链路日志系统 v4
 *
 * 核心升级：
 * - 存储完整的请求参数（messages, system prompt, tools）
 * - 存储完整的模型返回内容（raw response）
 * - 存储转换后的 Cursor 请求
 * - 阶段耗时追踪 (Phase Timing)
 * - TTFT (Time To First Token)
 * - 用户问题标题提取
 * - 日志文件持久化（JSONL 格式，可配置开关）
 * - 日志清空操作
 * - 全部通过 Web UI 可视化
 */

import { EventEmitter } from 'events';
import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { getConfig, onConfigReload } from './config.js';
import { initDb, closeDb, isDbInitialized, dbInsertRequest, dbGetPayload, dbGetSummaries, dbCountSummaries, dbGetSummaryCount, dbGetStatusCounts, dbGetSummariesSince, dbClear, dbGetStats } from './logger-db.js';

// ==================== 类型定义 ====================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogSource = 'Handler' | 'OpenAI' | 'Cursor' | 'Auth' | 'System' | 'Converter';
export type LogPhase = 
    | 'receive' | 'auth' | 'convert' | 'intercept' | 'send'
    | 'response' | 'refusal' | 'retry' | 'truncation' | 'continuation'
    | 'thinking' | 'toolparse' | 'sanitize' | 'stream' | 'complete' | 'error';

export interface LogEntry {
    id: string;
    requestId: string;
    timestamp: number;
    level: LogLevel;
    source: LogSource;
    phase: LogPhase;
    message: string;
    details?: unknown;
    duration?: number;
}

export interface PhaseTiming {
    phase: LogPhase;
    label: string;
    startTime: number;
    endTime?: number;
    duration?: number;
}

/** 
 * 完整请求数据 — 存储每个请求的全量参数和响应
 */
export interface RequestPayload {
    // ===== 原始请求 =====
    /** 原始请求 body（Anthropic 或 OpenAI 格式） */
    originalRequest?: unknown;
    /** System prompt（提取出来方便查看） */
    systemPrompt?: string;
    /** 用户消息列表摘要 */
    messages?: Array<{ role: string; contentPreview: string; contentLength: number; hasImages?: boolean }>;
    /** 工具定义列表 */
    tools?: Array<{ name: string; description?: string }>;
    
    // ===== 转换后请求 =====
    /** 转换后的 Cursor 请求 */
    cursorRequest?: unknown;
    /** Cursor 消息列表摘要 */
    cursorMessages?: Array<{ role: string; contentPreview: string; contentLength: number }>;
    
    // ===== 模型响应 =====
    /** 原始模型返回全文 */
    rawResponse?: string;
    /** 清洗/处理后的最终响应 */
    finalResponse?: string;
    /** Thinking 内容 */
    thinkingContent?: string;
    /** 工具调用解析结果 */
    toolCalls?: unknown[];
    /** 每次重试的原始响应 */
    retryResponses?: Array<{ attempt: number; response: string; reason: string }>;
    /** 每次续写的原始响应 */
    continuationResponses?: Array<{ index: number; response: string; dedupedLength: number }>;
    /** summary 模式：最后一个用户问题 */
    question?: string;
    /** summary 模式：最终回答摘要 */
    answer?: string;
    /** summary 模式：回答类型 */
    answerType?: 'text' | 'tool_calls' | 'empty';
    /** summary 模式：工具调用名称列表 */
    toolCallNames?: string[];
}

export interface RequestSummary {
    requestId: string;
    startTime: number;
    endTime?: number;
    method: string;
    path: string;
    model: string;
    stream: boolean;
    apiFormat: 'anthropic' | 'openai' | 'responses';
    hasTools: boolean;
    toolCount: number;
    messageCount: number;
    status: 'processing' | 'success' | 'degraded' | 'error' | 'intercepted';
    responseChars: number;
    retryCount: number;
    continuationCount: number;
    stopReason?: string;
    error?: string;
    statusReason?: string;
    issueTags?: string[];
    toolCallsDetected: number;
    ttft?: number;
    cursorApiTime?: number;
    phaseTimings: PhaseTiming[];
    thinkingChars: number;
    systemPromptLength: number;
    inputTokens?: number;   // 请求发出时的估算输入 token 数（js-tiktoken）
    outputTokens?: number;  // 响应完成后的估算输出 token 数（js-tiktoken）
    /** 用户提问标题（截取最后一个 user 消息的前 80 字符） */
    title?: string;
}

interface CompletionAssessment {
    status: RequestSummary['status'];
    statusReason?: string;
    issueTags?: string[];
}

// ==================== 存储 ====================

const MAX_ENTRIES = 5000;
const MAX_REQUESTS = 200;

let logCounter = 0;
const logEntries: LogEntry[] = [];
const requestSummaries: Map<string, RequestSummary> = new Map();
const requestPayloads: Map<string, RequestPayload> = new Map();
const requestOrder: string[] = [];

const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(50);

function shortId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
}

// ==================== 日志文件持久化 ====================

const DEFAULT_PERSIST_MODE: 'compact' | 'full' | 'summary' = 'summary';
const DISK_SYSTEM_PROMPT_CHARS = 2000;
const DISK_MESSAGE_PREVIEW_CHARS = 3000;
const DISK_CURSOR_MESSAGE_PREVIEW_CHARS = 2000;
const DISK_RESPONSE_CHARS = 8000;
const DISK_THINKING_CHARS = 4000;
const DISK_TOOL_DESC_CHARS = 500;
const DISK_RETRY_CHARS = 2000;
const DISK_TOOLCALL_STRING_CHARS = 1200;
const DISK_MAX_ARRAY_ITEMS = 20;
const DISK_MAX_OBJECT_DEPTH = 5;
const DISK_SUMMARY_QUESTION_CHARS = 2000;
const DISK_SUMMARY_ANSWER_CHARS = 4000;

function getLogDir(): string | null {
    const cfg = getConfig();
    if (!cfg.logging?.file_enabled) return null;
    return cfg.logging.dir || './logs';
}

function getPersistMode(): 'compact' | 'full' | 'summary' {
    const mode = getConfig().logging?.persist_mode;
    return mode === 'full' || mode === 'summary' || mode === 'compact' ? mode : DEFAULT_PERSIST_MODE;
}

function getLogFilePath(): string | null {
    const dir = getLogDir();
    if (!dir) return null;
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return join(dir, `cursor2api-${date}.jsonl`);
}

function ensureLogDir(): void {
    const dir = getLogDir();
    if (dir && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

function truncateMiddle(text: string, maxChars: number): string {
    if (!text || text.length <= maxChars) return text;
    const omitted = text.length - maxChars;
    const marker = `\n...[截断 ${omitted} chars]...\n`;
    const remain = Math.max(16, maxChars - marker.length);
    const head = Math.ceil(remain * 0.7);
    const tail = Math.max(8, remain - head);
    return text.slice(0, head) + marker + text.slice(text.length - tail);
}

function compactUnknownValue(value: unknown, maxStringChars = DISK_TOOLCALL_STRING_CHARS, depth = 0): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return truncateMiddle(value, maxStringChars);
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
    if (depth >= DISK_MAX_OBJECT_DEPTH) {
        if (Array.isArray(value)) return `[array(${value.length})]`;
        return '[object]';
    }
    if (Array.isArray(value)) {
        const items = value.slice(0, DISK_MAX_ARRAY_ITEMS)
            .map(item => compactUnknownValue(item, maxStringChars, depth + 1));
        if (value.length > DISK_MAX_ARRAY_ITEMS) {
            items.push(`[... ${value.length - DISK_MAX_ARRAY_ITEMS} more items]`);
        }
        return items;
    }
    if (typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            const limit = /content|text|arguments|description|prompt|response|reasoning/i.test(key)
                ? maxStringChars
                : Math.min(maxStringChars, 400);
            result[key] = compactUnknownValue(entry, limit, depth + 1);
        }
        return result;
    }
    return String(value);
}

function extractTextParts(value: unknown): string {
    if (typeof value === 'string') return value;
    if (!value) return '';
    if (Array.isArray(value)) {
        return value
            .map(item => extractTextParts(item))
            .filter(Boolean)
            .join('\n');
    }
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (typeof record.text === 'string') return record.text;
        if (typeof record.output === 'string') return record.output;
        if (typeof record.content === 'string') return record.content;
        if (record.content !== undefined) return extractTextParts(record.content);
        if (record.input !== undefined) return extractTextParts(record.input);
    }
    return '';
}

function extractLastUserQuestion(summary: RequestSummary, payload: RequestPayload): string | undefined {
    const lastUser = payload.messages?.slice().reverse().find(m => m.role === 'user' && m.contentPreview?.trim());
    if (lastUser?.contentPreview) {
        return truncateMiddle(lastUser.contentPreview, DISK_SUMMARY_QUESTION_CHARS);
    }

    const original = payload.originalRequest && typeof payload.originalRequest === 'object' && !Array.isArray(payload.originalRequest)
        ? payload.originalRequest as Record<string, unknown>
        : undefined;
    if (!original) {
        return summary.title ? truncateMiddle(summary.title, DISK_SUMMARY_QUESTION_CHARS) : undefined;
    }

    if (Array.isArray(original.messages)) {
        for (let i = original.messages.length - 1; i >= 0; i--) {
            const item = original.messages[i] as Record<string, unknown>;
            if (item?.role === 'user') {
                const text = extractTextParts(item.content);
                if (text.trim()) return truncateMiddle(text, DISK_SUMMARY_QUESTION_CHARS);
            }
        }
    }

    if (typeof original.input === 'string' && original.input.trim()) {
        return truncateMiddle(original.input, DISK_SUMMARY_QUESTION_CHARS);
    }
    if (Array.isArray(original.input)) {
        for (let i = original.input.length - 1; i >= 0; i--) {
            const item = original.input[i] as Record<string, unknown>;
            if (!item) continue;
            const role = typeof item.role === 'string' ? item.role : 'user';
            if (role === 'user') {
                const text = extractTextParts(item.content ?? item.input ?? item);
                if (text.trim()) return truncateMiddle(text, DISK_SUMMARY_QUESTION_CHARS);
            }
        }
    }

    return summary.title ? truncateMiddle(summary.title, DISK_SUMMARY_QUESTION_CHARS) : undefined;
}

function extractToolCallNames(payload: RequestPayload): string[] {
    if (!payload.toolCalls?.length) return [];
    return payload.toolCalls
        .map(call => {
            if (call && typeof call === 'object') {
                const record = call as Record<string, unknown>;
                if (typeof record.name === 'string') return record.name;
                const fn = record.function;
                if (fn && typeof fn === 'object' && typeof (fn as Record<string, unknown>).name === 'string') {
                    return (fn as Record<string, unknown>).name as string;
                }
            }
            return '';
        })
        .filter(Boolean);
}

function buildSummaryPayload(summary: RequestSummary, payload: RequestPayload): RequestPayload {
    const question = extractLastUserQuestion(summary, payload);
    const answerText = payload.finalResponse || payload.rawResponse || '';
    const toolCallNames = extractToolCallNames(payload);
    const answer = answerText
        ? truncateMiddle(answerText, DISK_SUMMARY_ANSWER_CHARS)
        : toolCallNames.length > 0
            ? `[tool_calls] ${toolCallNames.join(', ')}`
            : undefined;

    return {
        ...(question ? { question } : {}),
        ...(answer ? { answer } : {}),
        answerType: answerText ? 'text' : toolCallNames.length > 0 ? 'tool_calls' : 'empty',
        ...(toolCallNames.length > 0 ? { toolCallNames } : {}),
    };
}

const TOOL_UNAVAILABLE_PATTERNS: RegExp[] = [
    /read-only documentation tools/i,
    /documentation read tools/i,
    /only documentation.*tools/i,
    /\bi don't have (?:a |the )?(?:write|edit|bash)\b/i,
    /\bi (?:can't|cannot) (?:create|write|save|edit|modify) files? directly\b/i,
    /\bsave (?:this|it).+manually\b/i,
    /只(?:有|能用).*(?:文档|只读).*(?:工具|tool)/,
    /没有.*(?:Write|Bash|Edit).*工具/i,
    /无法直接(?:创建|写入|保存|修改|编辑)文件/,
];

const SELF_REPAIR_AFTER_CUTOFF_PATTERNS: RegExp[] = [
    /\b(?:file|response|output).{0,40}(?:got )?cut (?:off|short)\b/i,
    /\bgot cut at line \d+\b/i,
    /\bread what was written and complete it\b/i,
    /\bappend the remaining (?:content|sections)\b/i,
    /\bcomplete the remaining\b/i,
    /文件.*(?:被截断|写到一半|没写完|写残)/,
    /(?:补上|追加)剩余(?:内容|部分|章节)/,
    /继续补全/,
];

function assessCompletionOutcome(summary: RequestSummary, payload: RequestPayload, stopReason?: string): CompletionAssessment {
    const finalText = [payload.finalResponse, payload.rawResponse]
        .find((text): text is string => typeof text === 'string' && text.trim().length > 0)
        ?.trim() || '';

    const issueTags: string[] = [];
    const reasonParts: string[] = [];

    const missingToolExecution = summary.hasTools
        && summary.toolCallsDetected === 0
        && finalText.length > 0
        && TOOL_UNAVAILABLE_PATTERNS.some(pattern => pattern.test(finalText));

    if (missingToolExecution) {
        issueTags.push('tool_unavailable');
        reasonParts.push('模型声称工具不可用，未执行实际工具调用');
    }

    const truncatedWithoutRecovery = stopReason === 'max_tokens' && summary.continuationCount === 0;
    if (truncatedWithoutRecovery) {
        issueTags.push('truncated_output');
        reasonParts.push('响应触发 max_tokens 且未自动续写');
    }

    const selfRepairAfterCutoff = summary.hasTools
        && finalText.length > 0
        && SELF_REPAIR_AFTER_CUTOFF_PATTERNS.some(pattern => pattern.test(finalText));
    if (selfRepairAfterCutoff) {
        issueTags.push('self_repair_after_cutoff');
        reasonParts.push('模型自述上一步输出或写入被截断，当前请求在补救补写');
    }

    if (issueTags.length > 0) {
        return {
            status: 'degraded',
            statusReason: reasonParts.join('；'),
            issueTags,
        };
    }

    return { status: 'success' };
}

function buildCompactOriginalRequest(summary: RequestSummary, payload: RequestPayload): Record<string, unknown> | undefined {
    const original = payload.originalRequest && typeof payload.originalRequest === 'object' && !Array.isArray(payload.originalRequest)
        ? payload.originalRequest as Record<string, unknown>
        : undefined;
    const result: Record<string, unknown> = {
        model: summary.model,
        stream: summary.stream,
        apiFormat: summary.apiFormat,
        messageCount: summary.messageCount,
        toolCount: summary.toolCount,
    };

    if (summary.title) result.title = summary.title;
    if (payload.systemPrompt) result.systemPromptPreview = truncateMiddle(payload.systemPrompt, DISK_SYSTEM_PROMPT_CHARS);
    if (payload.messages?.some(m => m.hasImages)) result.hasImages = true;

    const lastUser = payload.messages?.slice().reverse().find(m => m.role === 'user');
    if (lastUser?.contentPreview) {
        result.lastUserPreview = truncateMiddle(lastUser.contentPreview, 800);
    }

    if (original) {
        for (const key of ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
            const value = original[key];
            if (value !== undefined && typeof value !== 'object') result[key] = value;
        }
        if (typeof original.instructions === 'string') {
            result.instructions = truncateMiddle(original.instructions, 1200);
        }
        if (typeof original.system === 'string') {
            result.system = truncateMiddle(original.system, DISK_SYSTEM_PROMPT_CHARS);
        }
    }

    return Object.keys(result).length > 0 ? result : undefined;
}

function compactPayloadForDisk(summary: RequestSummary, payload: RequestPayload): RequestPayload {
    const compact: RequestPayload = {};

    if (payload.originalRequest !== undefined) {
        compact.originalRequest = buildCompactOriginalRequest(summary, payload);
    }
    if (payload.systemPrompt) {
        compact.systemPrompt = truncateMiddle(payload.systemPrompt, DISK_SYSTEM_PROMPT_CHARS);
    }
    if (payload.messages?.length) {
        compact.messages = payload.messages.map(msg => ({
            ...msg,
            contentPreview: truncateMiddle(msg.contentPreview, DISK_MESSAGE_PREVIEW_CHARS),
        }));
    }
    if (payload.tools?.length) {
        compact.tools = payload.tools.map(tool => ({
            name: tool.name,
            ...(tool.description ? { description: truncateMiddle(tool.description, DISK_TOOL_DESC_CHARS) } : {}),
        }));
    }
    if (payload.cursorRequest !== undefined) {
        compact.cursorRequest = payload.cursorRequest;
    }
    if (payload.cursorMessages?.length) {
        compact.cursorMessages = payload.cursorMessages.map(msg => ({
            ...msg,
            contentPreview: truncateMiddle(msg.contentPreview, DISK_CURSOR_MESSAGE_PREVIEW_CHARS),
        }));
    }

    const compactFinalResponse = payload.finalResponse
        ? truncateMiddle(payload.finalResponse, DISK_RESPONSE_CHARS)
        : undefined;
    const compactRawResponse = payload.rawResponse
        ? truncateMiddle(payload.rawResponse, DISK_RESPONSE_CHARS)
        : undefined;

    if (compactFinalResponse) compact.finalResponse = compactFinalResponse;
    if (compactRawResponse && compactRawResponse !== compactFinalResponse) {
        compact.rawResponse = compactRawResponse;
    }
    if (payload.thinkingContent) {
        compact.thinkingContent = truncateMiddle(payload.thinkingContent, DISK_THINKING_CHARS);
    }
    if (payload.toolCalls?.length) {
        compact.toolCalls = compactUnknownValue(payload.toolCalls) as unknown[];
    }
    if (payload.retryResponses?.length) {
        compact.retryResponses = payload.retryResponses.map(item => ({
            ...item,
            response: truncateMiddle(item.response, DISK_RETRY_CHARS),
            reason: truncateMiddle(item.reason, 300),
        }));
    }
    if (payload.continuationResponses?.length) {
        compact.continuationResponses = payload.continuationResponses.map(item => ({
            ...item,
            response: truncateMiddle(item.response, DISK_RETRY_CHARS),
        }));
    }

    return compact;
}

/** 将已完成的请求写入日志文件和/或 SQLite */
function persistRequest(summary: RequestSummary, payload: RequestPayload): void {
    // ---- 原有 JSONL 文件方式（保持不变）----
    const filepath = getLogFilePath();
    if (filepath) {
        try {
            ensureLogDir();
            const persistMode = getPersistMode();
            const persistedPayload = persistMode === 'full'
                ? payload
                : persistMode === 'summary'
                    ? buildSummaryPayload(summary, payload)
                    : compactPayloadForDisk(summary, payload);
            const record = { timestamp: Date.now(), summary, payload: persistedPayload };
            appendFileSync(filepath, JSON.stringify(record) + '\n', 'utf-8');
        } catch (e) {
            console.warn('[Logger] 写入日志文件失败:', e);
        }
    }

    // ---- 新增 SQLite 方式 ----
    const cfg = getConfig();
    if (cfg.logging?.db_enabled) {
        try {
            dbInsertRequest(summary, payload);
        } catch (e) {
            console.warn('[Logger] 写入 SQLite 失败:', e);
        }
    }
}

/** 启动时从日志文件和/或 SQLite 加载历史记录 */
export function loadLogsFromFiles(): void {
    const cfg = getConfig();

    // ---- 新增：SQLite 加载（只加载 summary，不加载 payload，彻底避免 OOM）----
    if (cfg.logging?.db_enabled) {
        try {
            const maxDays = cfg.logging?.max_days || 7;
            const cutoff = Date.now() - maxDays * 86400000;
            // 初始化 SQLite（若尚未在 index.ts 中初始化则在此兜底）
            try { initDb(cfg.logging.db_path || './logs/cursor2api.db'); } catch { /* already initialized */ }
            const summaries = dbGetSummariesSince(cutoff);
            let dbLoaded = 0;
            for (const s of summaries) {
                if (!requestSummaries.has(s.requestId)) {
                    requestSummaries.set(s.requestId, s as RequestSummary);
                    // 不预加载 payload，按需查询
                    requestOrder.push(s.requestId);
                    dbLoaded++;
                }
            }
            // 裁剪到 MAX_REQUESTS（保留最新的）
            while (requestOrder.length > MAX_REQUESTS) {
                const oldId = requestOrder.shift()!;
                requestSummaries.delete(oldId);
                requestPayloads.delete(oldId);
            }
            if (dbLoaded > 0) {
                console.log(`[Logger] 从 SQLite 加载了 ${dbLoaded} 条历史摘要（不含 payload）`);
            }
        } catch (e) {
            console.warn('[Logger] 从 SQLite 加载失败:', e);
        }
    }

    // ---- 原有 JSONL 文件加载（db_enabled 时跳过读取，避免 OOM；仅清理过期文件）----
    const dir = getLogDir();
    if (!dir || !existsSync(dir)) return;
    try {
        const maxDays = cfg.logging?.max_days || 7;
        const cutoff = Date.now() - maxDays * 86400000;

        const files = readdirSync(dir)
            .filter(f => f.startsWith('cursor2api-') && f.endsWith('.jsonl'))
            .sort(); // 按日期排序

        // 清理过期文件
        for (const f of files) {
            const dateStr = f.replace('cursor2api-', '').replace('.jsonl', '');
            const fileDate = new Date(dateStr).getTime();
            if (fileDate < cutoff) {
                try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
                continue;
            }
        }

        // db_enabled 时跳过文件读取（SQLite 已加载 summary，避免 OOM）
        if (!cfg.logging?.db_enabled) {
            // 加载有效文件（最多最近2个文件）
            const validFiles = readdirSync(dir)
                .filter(f => f.startsWith('cursor2api-') && f.endsWith('.jsonl'))
                .sort()
                .slice(-2);

            let loaded = 0;
            for (const f of validFiles) {
                const content = readFileSync(join(dir, f), 'utf-8');
                const lines = content.split('\n').filter(Boolean);
                for (const line of lines) {
                    try {
                        const record = JSON.parse(line);
                        if (record.summary && record.summary.requestId) {
                            const s = record.summary as RequestSummary;
                            const p = record.payload as RequestPayload || {};
                            if (!requestSummaries.has(s.requestId)) {
                                requestSummaries.set(s.requestId, s);
                                requestPayloads.set(s.requestId, p);
                                requestOrder.push(s.requestId);
                                loaded++;
                            }
                        }
                    } catch { /* skip malformed lines */ }
                }
            }

            // 裁剪到 MAX_REQUESTS
            while (requestOrder.length > MAX_REQUESTS) {
                const oldId = requestOrder.shift()!;
                requestSummaries.delete(oldId);
                requestPayloads.delete(oldId);
            }

            if (loaded > 0) {
                console.log(`[Logger] 从日志文件加载了 ${loaded} 条历史记录`);
            }
        }
    } catch (e) {
        console.warn('[Logger] 加载日志文件失败:', e);
    }
}

// ==================== SQLite 热重载 ====================
// 注册配置热重载回调，处理 db_enabled / db_path 运行时变更
onConfigReload((newCfg, changes) => {
    // 只在 logging 配置变更时处理（避免其他字段变更触发不必要的 DB 重初始化）
    if (!changes.some(c => c.startsWith('logging'))) return;

    const dbEnabled = newCfg.logging?.db_enabled ?? false;
    const dbPath = newCfg.logging?.db_path || './logs/cursor2api.db';

    if (dbEnabled) {
        // 启用或路径变更：重新初始化（initDb 内部会先关闭旧连接）
        try {
            initDb(dbPath);
            console.log(`[Logger] SQLite 热重载：已初始化 ${dbPath}`);
        } catch (e) {
            console.warn('[Logger] SQLite 热重载初始化失败:', e);
        }
    } else {
        // 禁用：关闭连接
        if (isDbInitialized()) {
            closeDb();
            console.log('[Logger] SQLite 热重载：已关闭连接');
        }
    }
});

/** 清空所有日志（内存 + 文件） */
export function clearAllLogs(): { cleared: number } {
    const count = requestSummaries.size;
    logEntries.length = 0;
    requestSummaries.clear();
    requestPayloads.clear();
    requestOrder.length = 0;
    logCounter = 0;
    
    // 清空日志文件
    const dir = getLogDir();
    if (dir && existsSync(dir)) {
        try {
            const files = readdirSync(dir).filter(f => f.startsWith('cursor2api-') && f.endsWith('.jsonl'));
            for (const f of files) {
                try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
            }
        } catch { /* ignore */ }
    }

    // 清空 SQLite
    const cfg = getConfig();
    if (cfg.logging?.db_enabled) {
        try { dbClear(); } catch { /* ignore */ }
    }

    return { cleared: count };
}

// ==================== 统计 ====================

export function getStats() {
    let success = 0, degraded = 0, error = 0, intercepted = 0, processing = 0;
    let totalTime = 0, timeCount = 0, totalTTFT = 0, ttftCount = 0;
    for (const s of requestSummaries.values()) {
        if (s.status === 'success') success++;
        else if (s.status === 'degraded') degraded++;
        else if (s.status === 'error') error++;
        else if (s.status === 'intercepted') intercepted++;
        else if (s.status === 'processing') processing++;
        if (s.endTime) { totalTime += s.endTime - s.startTime; timeCount++; }
        if (s.ttft) { totalTTFT += s.ttft; ttftCount++; }
    }
    return {
        totalRequests: requestSummaries.size,
        successCount: success, degradedCount: degraded, errorCount: error,
        interceptedCount: intercepted, processingCount: processing,
        avgResponseTime: timeCount > 0 ? Math.round(totalTime / timeCount) : 0,
        avgTTFT: ttftCount > 0 ? Math.round(totalTTFT / ttftCount) : 0,
        totalLogEntries: logEntries.length,
    };
}

export function getVueStats(since?: number) {
    const cfg = getConfig();
    if (cfg.logging?.db_enabled) {
        try {
            return { ...dbGetStats(since), totalLogEntries: logEntries.length };
        } catch (e) {
            console.warn('[Logger] dbGetStats 失败，降级到内存:', e);
        }
    }
    // 内存模式：since 参数忽略，数据本就有限，直接复用 getStats()
    return getStats();
}

// ==================== 核心 API ====================

export function createRequestLogger(opts: {
    method: string;
    path: string;
    model: string;
    stream: boolean;
    hasTools: boolean;
    toolCount: number;
    messageCount: number;
    apiFormat?: 'anthropic' | 'openai' | 'responses';
    systemPromptLength?: number;
}): RequestLogger {
    const requestId = shortId();
    const summary: RequestSummary = {
        requestId, startTime: Date.now(),
        method: opts.method, path: opts.path, model: opts.model,
        stream: opts.stream,
        apiFormat: opts.apiFormat || (opts.path.includes('chat/completions') ? 'openai' :
                   opts.path.includes('responses') ? 'responses' : 'anthropic'),
        hasTools: opts.hasTools, toolCount: opts.toolCount,
        messageCount: opts.messageCount,
        status: 'processing', responseChars: 0,
        retryCount: 0, continuationCount: 0, toolCallsDetected: 0,
        phaseTimings: [], thinkingChars: 0,
        systemPromptLength: opts.systemPromptLength || 0,
    };
    const payload: RequestPayload = {};
    
    requestSummaries.set(requestId, summary);
    requestPayloads.set(requestId, payload);
    requestOrder.push(requestId);
    
    while (requestOrder.length > MAX_REQUESTS) {
        const oldId = requestOrder.shift()!;
        requestSummaries.delete(oldId);
        requestPayloads.delete(oldId);
    }

    const toolMode = (() => {
        const cfg = getConfig().tools;
        if (cfg?.disabled) return '(跳过)';
        if (cfg?.passthrough) return '(透传)';
        return '';
    })();
    const toolInfo = opts.hasTools ? ` tools=${opts.toolCount}${toolMode}` : '';
    const fmtTag = summary.apiFormat === 'openai' ? ' [OAI]' : summary.apiFormat === 'responses' ? ' [RSP]' : '';
    console.log(`\x1b[36m⟶\x1b[0m [${requestId}] ${opts.method} ${opts.path}${fmtTag} | model=${opts.model} stream=${opts.stream}${toolInfo} msgs=${opts.messageCount}`);
    
    return new RequestLogger(requestId, summary, payload);
}

export function getAllLogs(opts?: { requestId?: string; level?: LogLevel; source?: LogSource; limit?: number; since?: number }): LogEntry[] {
    let result = logEntries;
    if (opts?.requestId) result = result.filter(e => e.requestId === opts.requestId);
    if (opts?.level) {
        const levels: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
        const minLevel = levels[opts.level];
        result = result.filter(e => levels[e.level] >= minLevel);
    }
    if (opts?.source) result = result.filter(e => e.source === opts.source);
    if (opts?.since) result = result.filter(e => e.timestamp > opts!.since!);
    if (opts?.limit) result = result.slice(-opts.limit);
    return result;
}

export function getRequestSummaries(limit?: number): RequestSummary[] {
    const ids = limit ? requestOrder.slice(-limit) : requestOrder;
    return ids.map(id => requestSummaries.get(id)!).filter(Boolean).reverse();
}

/** 获取请求的完整 payload 数据 */
export function getRequestPayload(requestId: string): RequestPayload | undefined {
    // 先查内存
    const cached = requestPayloads.get(requestId);
    if (cached) return cached;
    // 内存无（SQLite 模式下 payload 不预加载）→ 按需查 SQLite
    const cfg = getConfig();
    if (cfg.logging?.db_enabled) {
        try { return dbGetPayload(requestId); } catch { /* ignore */ }
    }
    return undefined;
}

/**
 * 游标分页查询请求摘要列表（仅 Vue UI 使用）。
 * 支持 status/keyword/since 后端过滤，before 游标翻页。
 * 结果按 startTime 倒序（最新在前）。
 */
export function getRequestSummariesPage(opts: {
    limit: number;
    before?: number;
    status?: string;
    keyword?: string;
    since?: number;
}): { summaries: RequestSummary[]; hasMore: boolean; total: number; statusCounts: Record<string, number> } {
    const { limit, before, status, keyword, since } = opts;
    const cfg = getConfig();

    if (cfg.logging?.db_enabled) {
        // SQLite 支持完整历史翻页 + 后端过滤
        try {
            const summaries = dbGetSummaries({ limit: limit + 1, before, status, keyword, since }) as RequestSummary[];
            const hasMore = summaries.length > limit;
            return {
                summaries: hasMore ? summaries.slice(0, limit) : summaries,
                hasMore,
                total: dbCountSummaries({ since, status, keyword }),
                statusCounts: dbGetStatusCounts({ keyword, since }),
            };
        } catch (e) {
            console.warn('[Logger] SQLite 分页查询失败:', e);
        }
    }

    // 降级：从内存 requestOrder 切片（支持基本过滤）
    // statusCounts 不受 status 过滤影响，单独计算
    let allUnfiltered = requestOrder.slice().reverse();
    if (since !== undefined) allUnfiltered = allUnfiltered.filter(id => (requestSummaries.get(id)?.startTime ?? 0) >= since);
    if (keyword) {
        const kw = keyword.toLowerCase();
        allUnfiltered = allUnfiltered.filter(id => {
            const s = requestSummaries.get(id);
            return s && (
                s.requestId.toLowerCase().includes(kw) ||
                s.model.toLowerCase().includes(kw) ||
                (s.title ?? '').toLowerCase().includes(kw)
            );
        });
    }
    const statusCounts: Record<string, number> = { all: allUnfiltered.length, success: 0, degraded: 0, error: 0, processing: 0, intercepted: 0 };
    for (const id of allUnfiltered) {
        const s = requestSummaries.get(id);
        if (s?.status) statusCounts[s.status] = (statusCounts[s.status] ?? 0) + 1;
    }

    let all = status ? allUnfiltered.filter(id => requestSummaries.get(id)?.status === status) : allUnfiltered;
    const startIdx = before !== undefined
        ? all.findIndex(id => (requestSummaries.get(id)?.startTime ?? Infinity) < before)
        : 0;
    const slice = startIdx >= 0 ? all.slice(startIdx, startIdx + limit + 1) : [];
    const hasMore = slice.length > limit;
    return {
        summaries: slice.slice(0, limit).map(id => requestSummaries.get(id)!).filter(Boolean),
        hasMore,
        total: all.length,
        statusCounts,
    };
}

export function subscribeToLogs(listener: (entry: LogEntry) => void): () => void {
    logEmitter.on('log', listener);
    return () => logEmitter.off('log', listener);
}

export function subscribeToSummaries(listener: (summary: RequestSummary) => void): () => void {
    logEmitter.on('summary', listener);
    return () => logEmitter.off('summary', listener);
}

function addEntry(entry: LogEntry): void {
    logEntries.push(entry);
    while (logEntries.length > MAX_ENTRIES) logEntries.shift();
    logEmitter.emit('log', entry);
}

// ==================== RequestLogger ====================

export class RequestLogger {
    readonly requestId: string;
    private summary: RequestSummary;
    private payload: RequestPayload;
    private activePhase: PhaseTiming | null = null;
    
    constructor(requestId: string, summary: RequestSummary, payload: RequestPayload) {
        this.requestId = requestId;
        this.summary = summary;
        this.payload = payload;
    }
    
    private log(level: LogLevel, source: LogSource, phase: LogPhase, message: string, details?: unknown): void {
        addEntry({
            id: `log_${++logCounter}`,
            requestId: this.requestId,
            timestamp: Date.now(),
            level, source, phase, message, details,
            duration: Date.now() - this.summary.startTime,
        });
    }
    
    // ---- 阶段追踪 ----
    startPhase(phase: LogPhase, label: string): void {
        if (this.activePhase && !this.activePhase.endTime) {
            this.activePhase.endTime = Date.now();
            this.activePhase.duration = this.activePhase.endTime - this.activePhase.startTime;
        }
        const t: PhaseTiming = { phase, label, startTime: Date.now() };
        this.activePhase = t;
        this.summary.phaseTimings.push(t);
    }
    endPhase(): void {
        if (this.activePhase && !this.activePhase.endTime) {
            this.activePhase.endTime = Date.now();
            this.activePhase.duration = this.activePhase.endTime - this.activePhase.startTime;
        }
    }
    
    // ---- 便捷方法 ----
    debug(source: LogSource, phase: LogPhase, message: string, details?: unknown): void { this.log('debug', source, phase, message, details); }
    info(source: LogSource, phase: LogPhase, message: string, details?: unknown): void { this.log('info', source, phase, message, details); }
    warn(source: LogSource, phase: LogPhase, message: string, details?: unknown): void {
        this.log('warn', source, phase, message, details);
        console.log(`\x1b[33m⚠\x1b[0m [${this.requestId}] ${message}`);
    }
    error(source: LogSource, phase: LogPhase, message: string, details?: unknown): void {
        this.log('error', source, phase, message, details);
        console.error(`\x1b[31m✗\x1b[0m [${this.requestId}] ${message}`);
    }
    
    // ---- 特殊事件 ----
    recordTTFT(): void { this.summary.ttft = Date.now() - this.summary.startTime; }
    recordCursorApiTime(startTime: number): void { this.summary.cursorApiTime = Date.now() - startTime; }
    
    // ---- 全量数据记录 ----
    
    /** 记录原始请求（包含 messages, system, tools 等） */
    recordOriginalRequest(body: any): void {
        // system prompt
        if (typeof body.system === 'string') {
            this.payload.systemPrompt = body.system;
        } else if (Array.isArray(body.system)) {
            this.payload.systemPrompt = body.system.map((b: any) => b.text || '').join('\n');
        }
        
        // messages 摘要 + 完整存储
        if (Array.isArray(body.messages)) {
            const MAX_MSG = 100000; // 单条消息最大存储 100K
            this.payload.messages = body.messages.map((m: any) => {
                let fullContent = '';
                let contentLength = 0;
                let hasImages = false;
                if (typeof m.content === 'string') {
                    fullContent = m.content.length > MAX_MSG ? m.content.substring(0, MAX_MSG) + '\n... [截断]' : m.content;
                    contentLength = m.content.length;
                } else if (Array.isArray(m.content)) {
                    const textParts = m.content.filter((c: any) => c.type === 'text');
                    const imageParts = m.content.filter((c: any) => c.type === 'image' || c.type === 'image_url' || c.type === 'input_image');
                    hasImages = imageParts.length > 0;
                    const text = textParts.map((c: any) => c.text || '').join('\n');
                    fullContent = text.length > MAX_MSG ? text.substring(0, MAX_MSG) + '\n... [截断]' : text;
                    contentLength = text.length;
                    if (hasImages) fullContent += `\n[+${imageParts.length} images]`;
                }
                return { role: m.role, contentPreview: fullContent, contentLength, hasImages };
            });
            
            // ★ 提取用户问题标题：取最后一个 user 消息的真实提问
            const userMsgs = body.messages.filter((m: any) => m.role === 'user');
            if (userMsgs.length > 0) {
                const lastUser = userMsgs[userMsgs.length - 1];
                let text = '';
                if (typeof lastUser.content === 'string') {
                    text = lastUser.content;
                } else if (Array.isArray(lastUser.content)) {
                    text = lastUser.content
                        .filter((c: any) => c.type === 'text')
                        .map((c: any) => c.text || '')
                        .join(' ');
                }
                // 去掉 <system-reminder>...</system-reminder> 等 XML 注入内容
                text = text.replace(/<[a-zA-Z_-]+>[\s\S]*?<\/[a-zA-Z_-]+>/gi, '');
                // 去掉 Claude Code 尾部的引导语
                text = text.replace(/First,\s*think\s+step\s+by\s+step[\s\S]*$/i, '');
                text = text.replace(/Respond with the appropriate action[\s\S]*$/i, '');
                // 清理换行、多余空格
                text = text.replace(/\s+/g, ' ').trim();
                this.summary.title = text.length > 80 ? text.substring(0, 77) + '...' : text;
            }
        }
        
        // tools — 完整记录，不截断描述（截断由 tools 配置控制，日志应保留原始信息）
        if (Array.isArray(body.tools)) {
            this.payload.tools = body.tools.map((t: any) => ({
                name: t.name || t.function?.name || 'unknown',
                description: t.description || t.function?.description || '',
            }));
        }
        
        // 存全量 (去掉 base64 图片数据避免内存爆炸)
        this.payload.originalRequest = this.sanitizeForStorage(body);
    }
    
    /** 记录转换后的 Cursor 请求 */
    recordCursorRequest(cursorReq: any): void {
        if (Array.isArray(cursorReq.messages)) {
            const MAX_MSG = 100000;
            this.payload.cursorMessages = cursorReq.messages.map((m: any) => {
                // Cursor 消息用 parts 而不是 content
                let text = '';
                if (m.parts && Array.isArray(m.parts)) {
                    text = m.parts.map((p: any) => p.text || '').join('\n');
                } else if (typeof m.content === 'string') {
                    text = m.content;
                } else if (m.content) {
                    text = JSON.stringify(m.content);
                }
                const fullContent = text.length > MAX_MSG ? text.substring(0, MAX_MSG) + '\n... [截断]' : text;
                return {
                    role: m.role,
                    contentPreview: fullContent,
                    contentLength: text.length,
                };
            });
        }
        // 存储不含完整消息体的 cursor 请求元信息
        this.payload.cursorRequest = {
            model: cursorReq.model,
            messageCount: cursorReq.messages?.length,
            totalChars: cursorReq.messages?.reduce((sum: number, m: any) => {
                if (m.parts && Array.isArray(m.parts)) {
                    return sum + m.parts.reduce((s: number, p: any) => s + (p.text?.length || 0), 0);
                }
                const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
                return sum + text.length;
            }, 0),
        };
    }
    
    /** 记录模型原始响应 */
    recordRawResponse(text: string): void {
        this.payload.rawResponse = text;
    }
    
    /** 记录最终响应 */
    recordFinalResponse(text: string): void {
        this.payload.finalResponse = text;
    }
    
    /** 记录 thinking 内容 */
    recordThinking(content: string): void {
        this.payload.thinkingContent = content;
        this.summary.thinkingChars = content.length;
    }
    
    /** 记录工具调用 */
    recordToolCalls(calls: unknown[]): void {
        this.payload.toolCalls = calls;
    }
    
    /** 记录重试响应 */
    recordRetryResponse(attempt: number, response: string, reason: string): void {
        if (!this.payload.retryResponses) this.payload.retryResponses = [];
        this.payload.retryResponses.push({ attempt, response, reason });
    }
    
    /** 记录续写响应 */
    recordContinuationResponse(index: number, response: string, dedupedLength: number): void {
        if (!this.payload.continuationResponses) this.payload.continuationResponses = [];
        this.payload.continuationResponses.push({ index, response: response.substring(0, 2000), dedupedLength });
    }
    
    /** 去除 base64 图片数据以节省内存 */
    private sanitizeForStorage(obj: any): any {
        if (!obj || typeof obj !== 'object') return obj;
        if (Array.isArray(obj)) return obj.map(item => this.sanitizeForStorage(item));
        const result: any = {};
        for (const [key, value] of Object.entries(obj)) {
            if (key === 'data' && typeof value === 'string' && (value as string).length > 1000) {
                result[key] = `[base64 data: ${(value as string).length} chars]`;
            } else if (key === 'source' && typeof value === 'object' && (value as any)?.type === 'base64') {
                result[key] = { type: 'base64', media_type: (value as any).media_type, data: `[${((value as any).data?.length || 0)} chars]` };
            } else if (typeof value === 'object') {
                result[key] = this.sanitizeForStorage(value);
            } else {
                result[key] = value;
            }
        }
        return result;
    }
    
    // ---- 摘要更新 ----
    updateSummary(updates: Partial<RequestSummary>): void {
        Object.assign(this.summary, updates);
        logEmitter.emit('summary', this.summary);
    }
    
    complete(responseChars: number, stopReason?: string): void {
        this.endPhase();
        const duration = Date.now() - this.summary.startTime;
        const assessment = assessCompletionOutcome(this.summary, this.payload, stopReason);
        this.summary.endTime = Date.now();
        this.summary.status = assessment.status;
        this.summary.statusReason = assessment.statusReason;
        this.summary.issueTags = assessment.issueTags;
        this.summary.responseChars = responseChars;
        this.summary.stopReason = stopReason;
        const completionMessage = assessment.status === 'degraded'
            ? `降级完成 (${duration}ms, ${responseChars} chars, stop=${stopReason})${assessment.statusReason ? ` - ${assessment.statusReason}` : ''}`
            : `完成 (${duration}ms, ${responseChars} chars, stop=${stopReason})`;
        this.log(assessment.status === 'degraded' ? 'warn' : 'info', 'System', 'complete', completionMessage);
        logEmitter.emit('summary', this.summary);
        
        // ★ 持久化到文件
        persistRequest(this.summary, this.payload);
        
        const retryInfo = this.summary.retryCount > 0 ? ` retry=${this.summary.retryCount}` : '';
        const contInfo = this.summary.continuationCount > 0 ? ` cont=${this.summary.continuationCount}` : '';
        const toolInfo = this.summary.toolCallsDetected > 0 ? ` tools_called=${this.summary.toolCallsDetected}` : '';
        const ttftInfo = this.summary.ttft ? ` ttft=${this.summary.ttft}ms` : '';
        const statusColor = assessment.status === 'degraded' ? '\x1b[33m' : '\x1b[32m';
        const statusLabel = assessment.status === 'degraded' ? 'DEGRADED' : 'OK';
        const reasonInfo = assessment.statusReason ? ` | reason=${assessment.statusReason}` : '';
        console.log(`${statusColor}${statusLabel}\x1b[0m [${this.requestId}] ${duration}ms | ${responseChars} chars | stop=${stopReason || 'end_turn'}${ttftInfo}${retryInfo}${contInfo}${toolInfo}${reasonInfo}`);
    }
    
    intercepted(reason: string): void {
        this.summary.status = 'intercepted';
        this.summary.endTime = Date.now();
        this.log('info', 'System', 'intercept', reason);
        logEmitter.emit('summary', this.summary);
        persistRequest(this.summary, this.payload);
        console.log(`\x1b[35m⊘\x1b[0m [${this.requestId}] 拦截: ${reason}`);
    }
    
    fail(error: string): void {
        this.endPhase();
        this.summary.status = 'error';
        this.summary.endTime = Date.now();
        this.summary.error = error;
        this.log('error', 'System', 'error', error);
        logEmitter.emit('summary', this.summary);
        persistRequest(this.summary, this.payload);
    }
}
