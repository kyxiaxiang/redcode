/**
 * openai-handler.ts - OpenAI Chat Completions API 兼容处理器
 *
 * 将 OpenAI 格式请求转换为内部 Anthropic 格式，复用现有 Cursor 交互管道
 * 支持流式和非流式响应、工具调用、Cursor IDE Agent 模式
 */

import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type {
    OpenAIChatRequest,
    OpenAIMessage,
    OpenAIChatCompletion,
    OpenAIChatCompletionChunk,
    OpenAIToolCall,
    OpenAIContentPart,
    OpenAITool,
} from './openai-types.js';
import type {
    AnthropicRequest,
    AnthropicMessage,
    AnthropicContentBlock,
    AnthropicTool,
    CursorChatRequest,
    CursorSSEEvent,
} from './types.js';
import { convertToCursorRequest, parseToolCalls, hasToolCalls } from './converter.js';
import { sendCursorRequest, sendCursorRequestFull } from './cursor-client.js';
import { getConfig } from './config.js';
import { createRequestLogger, type RequestLogger } from './logger.js';
import { createIncrementalTextStreamer, hasLeadingThinking, splitLeadingThinkingBlocks, stripThinkingTags } from './streaming-text.js';
import {
    autoContinueCursorToolResponseFull,
    autoContinueCursorToolResponseStream,
    isRefusal,
    sanitizeResponse,
    isIdentityProbe,
    isToolCapabilityQuestion,
    buildRetryRequest,
    extractThinking,
    CLAUDE_IDENTITY_RESPONSE,
    CLAUDE_TOOLS_RESPONSE,
    MAX_REFUSAL_RETRIES,
    estimateInputTokens,
} from './handler.js';

function chatId(): string {
    return 'chatcmpl-' + uuidv4().replace(/-/g, '').substring(0, 24);
}

function toolCallId(): string {
    return 'call_' + uuidv4().replace(/-/g, '').substring(0, 24);
}

class OpenAIRequestError extends Error {
    status: number;
    type: string;
    code: string;

    constructor(message: string, status = 400, type = 'invalid_request_error', code = 'invalid_request') {
        super(message);
        this.name = 'OpenAIRequestError';
        this.status = status;
        this.type = type;
        this.code = code;
    }
}

function stringifyUnknownContent(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value);
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function unsupportedImageFileError(fileId?: string): OpenAIRequestError {
    const suffix = fileId ? ` (file_id: ${fileId})` : '';
    return new OpenAIRequestError(
        `Unsupported content part: image_file${suffix}. This proxy does not support OpenAI Files API image references. Please send the image as image_url, input_image, data URI, or a local file path instead.`,
        400,
        'invalid_request_error',
        'unsupported_content_part'
    );
}

// ==================== 请求转换：OpenAI → Anthropic ====================

/**
 * 将 OpenAI Chat Completions 请求转换为内部 Anthropic 格式
 * 这样可以完全复用现有的 convertToCursorRequest 管道
 */
function convertToAnthropicRequest(body: OpenAIChatRequest): AnthropicRequest {
    const rawMessages: AnthropicMessage[] = [];
    let systemPrompt: string | undefined;

    // ★ response_format 处理：构建温和的 JSON 格式提示（稍后追加到最后一条用户消息）
    let jsonFormatSuffix = '';
    if (body.response_format && body.response_format.type !== 'text') {
        jsonFormatSuffix = '\n\nRespond in plain JSON format without markdown wrapping.';
        if (body.response_format.type === 'json_schema' && body.response_format.json_schema?.schema) {
            jsonFormatSuffix += ` Schema: ${JSON.stringify(body.response_format.json_schema.schema)}`;
        }
    }

    for (const msg of body.messages) {
        switch (msg.role) {
            case 'system':
                systemPrompt = (systemPrompt ? systemPrompt + '\n\n' : '') + extractOpenAIContent(msg);
                break;

            case 'user': {
                // 检查 content 数组中是否有 tool_result 类型的块（Anthropic 风格）
                const contentBlocks = extractOpenAIContentBlocks(msg);
                if (Array.isArray(contentBlocks)) {
                    rawMessages.push({ role: 'user', content: contentBlocks });
                } else {
                    rawMessages.push({ role: 'user', content: contentBlocks || '' });
                }
                break;
            }

            case 'assistant': {
                const blocks: AnthropicContentBlock[] = [];
                const contentBlocks = extractOpenAIContentBlocks(msg);
                if (typeof contentBlocks === 'string' && contentBlocks) {
                    blocks.push({ type: 'text', text: contentBlocks });
                } else if (Array.isArray(contentBlocks)) {
                    blocks.push(...contentBlocks);
                }

                if (msg.tool_calls && msg.tool_calls.length > 0) {
                    for (const tc of msg.tool_calls) {
                        let args: Record<string, unknown> = {};
                        try {
                            args = JSON.parse(tc.function.arguments);
                        } catch {
                            args = { input: tc.function.arguments };
                        }
                        blocks.push({
                            type: 'tool_use',
                            id: tc.id,
                            name: tc.function.name,
                            input: args,
                        });
                    }
                }

                rawMessages.push({
                    role: 'assistant',
                    content: blocks.length > 0 ? blocks : (typeof contentBlocks === 'string' ? contentBlocks : ''),
                });
                break;
            }

            case 'tool': {
                rawMessages.push({
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: msg.tool_call_id,
                        content: extractOpenAIContent(msg),
                    }] as AnthropicContentBlock[],
                });
                break;
            }
        }
    }

    // 合并连续同角色消息（Anthropic API 要求 user/assistant 严格交替）
    const messages = mergeConsecutiveRoles(rawMessages);

    // ★ response_format: 追加 JSON 格式提示到最后一条 user 消息
    if (jsonFormatSuffix) {
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') {
                const content = messages[i].content;
                if (typeof content === 'string') {
                    messages[i].content = content + jsonFormatSuffix;
                } else if (Array.isArray(content)) {
                    const lastTextBlock = [...content].reverse().find(b => b.type === 'text');
                    if (lastTextBlock && lastTextBlock.text) {
                        lastTextBlock.text += jsonFormatSuffix;
                    } else {
                        content.push({ type: 'text', text: jsonFormatSuffix.trim() });
                    }
                }
                break;
            }
        }
    }

    // 转换工具定义：支持 OpenAI 标准格式和 Cursor 扁平格式
    const tools: AnthropicTool[] | undefined = body.tools?.map((t: OpenAITool | Record<string, unknown>) => {
        // Cursor IDE 可能发送扁平格式：{ name, description, input_schema }
        if ('function' in t && t.function) {
            const fn = (t as OpenAITool).function;
            return {
                name: fn.name,
                description: fn.description,
                input_schema: fn.parameters || { type: 'object', properties: {} },
            };
        }
        // Cursor 扁平格式
        const flat = t as Record<string, unknown>;
        return {
            name: (flat.name as string) || '',
            description: flat.description as string | undefined,
            input_schema: (flat.input_schema as Record<string, unknown>) || { type: 'object', properties: {} },
        };
    });

    return {
        model: body.model,
        messages,
        max_tokens: Math.max(body.max_tokens || body.max_completion_tokens || 8192, 8192),
        stream: body.stream,
        system: systemPrompt,
        tools,
        temperature: body.temperature,
        top_p: body.top_p,
        stop_sequences: body.stop
            ? (Array.isArray(body.stop) ? body.stop : [body.stop])
            : undefined,
        // ★ Thinking 开关：config.yaml 优先级最高
        // enabled=true: 强制注入 thinking（即使客户端没请求）
        // enabled=false: 强制关闭 thinking
        // 未配置: 跟随客户端（模型名含 'thinking' 或传了 reasoning_effort 才注入）
        ...(() => {
            const tc = getConfig().thinking;
            if (tc && tc.enabled) return { thinking: { type: 'enabled' as const } };
            if (tc && !tc.enabled) return {};
            // 未配置 → 跟随客户端信号
            const modelHint = body.model?.toLowerCase().includes('thinking');
            const effortHint = !!(body as unknown as Record<string, unknown>).reasoning_effort;
            return (modelHint || effortHint) ? { thinking: { type: 'enabled' as const } } : {};
        })(),
    };
}

/**
 * 合并连续同角色的消息（Anthropic API 要求角色严格交替）
 */
function mergeConsecutiveRoles(messages: AnthropicMessage[]): AnthropicMessage[] {
    if (messages.length <= 1) return messages;

    const merged: AnthropicMessage[] = [];
    for (const msg of messages) {
        const last = merged[merged.length - 1];
        if (last && last.role === msg.role) {
            // 合并 content
            const lastBlocks = toBlocks(last.content);
            const newBlocks = toBlocks(msg.content);
            last.content = [...lastBlocks, ...newBlocks];
        } else {
            merged.push({ ...msg });
        }
    }
    return merged;
}

/**
 * 将 content 统一转为 AnthropicContentBlock 数组
 */
function toBlocks(content: string | AnthropicContentBlock[]): AnthropicContentBlock[] {
    if (typeof content === 'string') {
        return content ? [{ type: 'text', text: content }] : [];
    }
    return content || [];
}

/**
 * 从 OpenAI 消息中提取文本或多模态内容块
 * 处理多种客户端格式：
 *   - 文本块: { type: 'text'|'input_text', text: '...' }
 *   - OpenAI 标准: { type: 'image_url', image_url: { url: '...' } }
 *   - Anthropic 透传: { type: 'image', source: { type: 'url', url: '...' } }
 *   - 部分客户端: { type: 'input_image', image_url: { url: '...' } }
 */
function extractOpenAIContentBlocks(msg: OpenAIMessage): string | AnthropicContentBlock[] {
    if (msg.content === null || msg.content === undefined) return '';
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
        const blocks: AnthropicContentBlock[] = [];
        for (const p of msg.content as (OpenAIContentPart | Record<string, unknown>)[]) {
            if ((p.type === 'text' || p.type === 'input_text') && (p as OpenAIContentPart).text) {
                blocks.push({ type: 'text', text: (p as OpenAIContentPart).text! });
            } else if (p.type === 'image_url' && (p as OpenAIContentPart).image_url?.url) {
                const url = (p as OpenAIContentPart).image_url!.url;
                if (url.startsWith('data:')) {
                    const match = url.match(/^data:([^;]+);base64,(.+)$/);
                    if (match) {
                        blocks.push({
                            type: 'image',
                            source: { type: 'base64', media_type: match[1], data: match[2] }
                        });
                    }
                } else {
                    // HTTP(S)/local URL — 统一存储到 source.data，由 preprocessImages() 下载/读取
                    blocks.push({
                        type: 'image',
                        source: { type: 'url', media_type: 'image/jpeg', data: url }
                    });
                }
            } else if (p.type === 'image' && (p as any).source) {
                // ★ Anthropic 格式透传：某些客户端混合发送 OpenAI 和 Anthropic 格式
                const source = (p as any).source;
                const imageUrl = source.url || source.data;
                if (source.type === 'base64' && source.data) {
                    blocks.push({
                        type: 'image',
                        source: { type: 'base64', media_type: source.media_type || 'image/jpeg', data: source.data }
                    });
                } else if (imageUrl) {
                    if (imageUrl.startsWith('data:')) {
                        const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
                        if (match) {
                            blocks.push({
                                type: 'image',
                                source: { type: 'base64', media_type: match[1], data: match[2] }
                            });
                        }
                    } else {
                        blocks.push({
                            type: 'image',
                            source: { type: 'url', media_type: source.media_type || 'image/jpeg', data: imageUrl }
                        });
                    }
                }
            } else if (p.type === 'input_image' && (p as any).image_url?.url) {
                // ★ input_image 类型：部分新版 API 客户端使用
                const url = (p as any).image_url.url;
                if (url.startsWith('data:')) {
                    const match = url.match(/^data:([^;]+);base64,(.+)$/);
                    if (match) {
                        blocks.push({
                            type: 'image',
                            source: { type: 'base64', media_type: match[1], data: match[2] }
                        });
                    }
                } else {
                    blocks.push({
                        type: 'image',
                        source: { type: 'url', media_type: 'image/jpeg', data: url }
                    });
                }
            } else if (p.type === 'image_file' && (p as any).image_file) {
                const fileId = (p as any).image_file.file_id as string | undefined;
                console.log(`[OpenAI] ⚠️ 收到不支持的 image_file 格式 (file_id: ${fileId || 'unknown'})`);
                throw unsupportedImageFileError(fileId);
            } else if ((p.type === 'image_url' || p.type === 'input_image') && (p as any).url) {
                // ★ 扁平 URL 格式：某些客户端将 url 直接放在顶层而非 image_url.url
                const url = (p as any).url as string;
                if (url.startsWith('data:')) {
                    const match = url.match(/^data:([^;]+);base64,(.+)$/);
                    if (match) {
                        blocks.push({
                            type: 'image',
                            source: { type: 'base64', media_type: match[1], data: match[2] }
                        });
                    }
                } else {
                    blocks.push({
                        type: 'image',
                        source: { type: 'url', media_type: 'image/jpeg', data: url }
                    });
                }
            } else if (p.type === 'tool_use') {
                // Anthropic 风格 tool_use 块直接透传
                blocks.push(p as unknown as AnthropicContentBlock);
            } else if (p.type === 'tool_result') {
                // Anthropic 风格 tool_result 块直接透传
                blocks.push(p as unknown as AnthropicContentBlock);
            } else {
                // ★ 通用兜底：检查未知类型的块是否包含可识别的图片数据
                const anyP = p as Record<string, unknown>;
                const possibleUrl = (anyP.url || anyP.file_path || anyP.path ||
                    (anyP.image_url as any)?.url || anyP.data) as string | undefined;
                if (possibleUrl && typeof possibleUrl === 'string') {
                    const looksLikeImage = /\.(jpg|jpeg|png|gif|webp|bmp|svg)/i.test(possibleUrl) ||
                        possibleUrl.startsWith('data:image/');
                    if (looksLikeImage) {
                        console.log(`[OpenAI] 🔄 未知内容类型 "${p.type}" 中检测到图片引用 → 转为 image block`);
                        if (possibleUrl.startsWith('data:')) {
                            const match = possibleUrl.match(/^data:([^;]+);base64,(.+)$/);
                            if (match) {
                                blocks.push({
                                    type: 'image',
                                    source: { type: 'base64', media_type: match[1], data: match[2] }
                                });
                            }
                        } else {
                            blocks.push({
                                type: 'image',
                                source: { type: 'url', media_type: 'image/jpeg', data: possibleUrl }
                            });
                        }
                    }
                }
            }
        }
        return blocks.length > 0 ? blocks : '';
    }
    return stringifyUnknownContent(msg.content);
}

/**
 * 仅提取纯文本（用于系统提示词和旧行为）
 */
function extractOpenAIContent(msg: OpenAIMessage): string {
    const blocks = extractOpenAIContentBlocks(msg);
    if (typeof blocks === 'string') return blocks;
    return blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

// ==================== 主处理入口 ====================

export async function handleOpenAIChatCompletions(req: Request, res: Response): Promise<void> {
    const body = req.body as OpenAIChatRequest;

    const log = createRequestLogger({
        method: req.method,
        path: req.path,
        model: body.model,
        stream: !!body.stream,
        hasTools: (body.tools?.length ?? 0) > 0,
        toolCount: body.tools?.length ?? 0,
        messageCount: body.messages?.length ?? 0,
        apiFormat: 'openai',
    });

    log.startPhase('receive', '接收请求');
    log.recordOriginalRequest(body);
    log.info('OpenAI', 'receive', `收到 OpenAI Chat 请求`, {
        model: body.model,
        messageCount: body.messages?.length,
        stream: body.stream,
        toolCount: body.tools?.length ?? 0,
    });

    // ★ 图片诊断日志：记录每条消息中的 content 格式，帮助定位客户端发送格式
    if (body.messages) {
        for (let i = 0; i < body.messages.length; i++) {
            const msg = body.messages[i];
            if (typeof msg.content === 'string') {
                // 检查字符串中是否包含图片路径特征
                if (/\.(jpg|jpeg|png|gif|webp|bmp|svg)/i.test(msg.content)) {
                    console.log(`[OpenAI] 📋 消息[${i}] role=${msg.role} content=字符串(${msg.content.length}chars) ⚠️ 包含图片后缀: ${msg.content.substring(0, 200)}`);
                }
            } else if (Array.isArray(msg.content)) {
                const types = (msg.content as any[]).map(p => {
                    if (p.type === 'image_url') return `image_url(${(p.image_url?.url || p.url || '?').substring(0, 60)})`;
                    if (p.type === 'image') return `image(${p.source?.type || '?'})`;
                    if (p.type === 'input_image') return `input_image`;
                    if (p.type === 'image_file') return `image_file`;
                    return p.type;
                });
                if (types.some(t => t !== 'text')) {
                    console.log(`[OpenAI] 📋 消息[${i}] role=${msg.role} blocks: [${types.join(', ')}]`);
                }
            }
        }
    }

    try {
        // Step 1: OpenAI → Anthropic 格式
        log.startPhase('convert', '格式转换 (OpenAI→Anthropic)');
        const anthropicReq = convertToAnthropicRequest(body);
        log.endPhase();

        // 注意：图片预处理已移入 convertToCursorRequest → preprocessImages() 统一处理

        // Step 1.6: 身份探针拦截（复用 Anthropic handler 的逻辑）
        if (isIdentityProbe(anthropicReq)) {
            log.intercepted('身份探针拦截 (OpenAI)');
            const mockText = "I am Claude, an advanced AI programming assistant created by Anthropic. I am ready to help you write code, debug, and answer your technical questions. Please let me know what we should work on!";
            if (body.stream) {
                return handleOpenAIMockStream(res, body, mockText);
            } else {
                return handleOpenAIMockNonStream(res, body, mockText);
            }
        }

        // Step 2: Anthropic → Cursor 格式（复用现有管道）
        const cursorReq = await convertToCursorRequest(anthropicReq);
        log.recordCursorRequest(cursorReq);

        if (body.stream) {
            await handleOpenAIStream(res, cursorReq, body, anthropicReq, log);
        } else {
            await handleOpenAINonStream(res, cursorReq, body, anthropicReq, log);
        }
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.fail(message);
        const status = err instanceof OpenAIRequestError ? err.status : 500;
        const type = err instanceof OpenAIRequestError ? err.type : 'server_error';
        const code = err instanceof OpenAIRequestError ? err.code : 'internal_error';
        res.status(status).json({
            error: {
                message,
                type,
                code,
            },
        });
    }
}

// ==================== 身份探针模拟响应 ====================

function handleOpenAIMockStream(res: Response, body: OpenAIChatRequest, mockText: string): void {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    const id = chatId();
    const created = Math.floor(Date.now() / 1000);
    writeOpenAISSE(res, {
        id, object: 'chat.completion.chunk', created, model: body.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: mockText }, finish_reason: null }],
    });
    writeOpenAISSE(res, {
        id, object: 'chat.completion.chunk', created, model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
    res.write('data: [DONE]\n\n');
    res.end();
}

function handleOpenAIMockNonStream(res: Response, body: OpenAIChatRequest, mockText: string): void {
    res.json({
        id: chatId(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
            index: 0,
            message: { role: 'assistant', content: mockText },
            finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 15, completion_tokens: 35, total_tokens: 50 },
    });
}

function writeOpenAITextDelta(
    res: Response,
    id: string,
    created: number,
    model: string,
    text: string,
): void {
    if (!text) return;
    writeOpenAISSE(res, {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{
            index: 0,
            delta: { content: text },
            finish_reason: null,
        }],
    });
}

function buildOpenAIUsage(
    anthropicReq: AnthropicRequest,
    outputText: string,
): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
    const promptTokens = estimateInputTokens(anthropicReq);
    const completionTokens = Math.ceil(outputText.length / 3);
    return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
    };
}

function writeOpenAIReasoningDelta(
    res: Response,
    id: string,
    created: number,
    model: string,
    reasoningContent: string,
): void {
    if (!reasoningContent) return;
    writeOpenAISSE(res, {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{
            index: 0,
            delta: { reasoning_content: reasoningContent } as Record<string, unknown>,
            finish_reason: null,
        }],
    });
}

async function handleOpenAIIncrementalTextStream(
    res: Response,
    cursorReq: CursorChatRequest,
    body: OpenAIChatRequest,
    anthropicReq: AnthropicRequest,
    streamMeta: { id: string; created: number; model: string },
    log: RequestLogger,
): Promise<void> {
    let activeCursorReq = cursorReq;
    let retryCount = 0;
    const thinkingEnabled = anthropicReq.thinking?.type === 'enabled';
    let finalRawResponse = '';
    let finalVisibleText = '';
    let finalReasoningContent = '';
    let streamer = createIncrementalTextStreamer({
        transform: sanitizeResponse,
        isBlockedPrefix: (text) => isRefusal(text.substring(0, 300)),
    });
    let reasoningSent = false;

    const executeAttempt = async (): Promise<{
        rawResponse: string;
        visibleText: string;
        reasoningContent: string;
        streamer: ReturnType<typeof createIncrementalTextStreamer>;
    }> => {
        let rawResponse = '';
        let visibleText = '';
        let leadingBuffer = '';
        let leadingResolved = false;
        let reasoningContent = '';
        const attemptStreamer = createIncrementalTextStreamer({
            transform: sanitizeResponse,
            isBlockedPrefix: (text) => isRefusal(text.substring(0, 300)),
        });

        const flushVisible = (chunk: string): void => {
            if (!chunk) return;
            visibleText += chunk;
            const delta = attemptStreamer.push(chunk);
            if (!delta) return;

            if (thinkingEnabled && reasoningContent && !reasoningSent) {
                writeOpenAIReasoningDelta(res, streamMeta.id, streamMeta.created, streamMeta.model, reasoningContent);
                reasoningSent = true;
            }
            writeOpenAITextDelta(res, streamMeta.id, streamMeta.created, streamMeta.model, delta);
        };

        await sendCursorRequest(activeCursorReq, (event: CursorSSEEvent) => {
            if (event.type !== 'text-delta' || !event.delta) return;

            rawResponse += event.delta;

            if (!leadingResolved) {
                leadingBuffer += event.delta;
                const split = splitLeadingThinkingBlocks(leadingBuffer);

                if (split.startedWithThinking) {
                    if (!split.complete) return;
                    reasoningContent = split.thinkingContent;
                    leadingResolved = true;
                    leadingBuffer = '';
                    flushVisible(split.remainder);
                    return;
                }

                leadingResolved = true;
                const buffered = leadingBuffer;
                leadingBuffer = '';
                flushVisible(buffered);
                return;
            }

            flushVisible(event.delta);
        });

        return {
            rawResponse,
            visibleText,
            reasoningContent,
            streamer: attemptStreamer,
        };
    };

    while (true) {
        const attempt = await executeAttempt();
        finalRawResponse = attempt.rawResponse;
        finalVisibleText = attempt.visibleText;
        finalReasoningContent = attempt.reasoningContent;
        streamer = attempt.streamer;

        const textForRefusalCheck = finalVisibleText;

        if (!streamer.hasSentText() && isRefusal(textForRefusalCheck) && retryCount < MAX_REFUSAL_RETRIES) {
            retryCount++;
            const retryBody = buildRetryRequest(anthropicReq, retryCount - 1);
            activeCursorReq = await convertToCursorRequest(retryBody);
            reasoningSent = false;
            continue;
        }

        break;
    }

    const refusalText = finalVisibleText;
    const usedFallback = !streamer.hasSentText() && isRefusal(refusalText);

    let finalTextToSend: string;
    if (usedFallback) {
        finalTextToSend = isToolCapabilityQuestion(anthropicReq)
            ? CLAUDE_TOOLS_RESPONSE
            : CLAUDE_IDENTITY_RESPONSE;
    } else {
        finalTextToSend = streamer.finish();
    }

    if (!usedFallback && thinkingEnabled && finalReasoningContent && !reasoningSent) {
        writeOpenAIReasoningDelta(res, streamMeta.id, streamMeta.created, streamMeta.model, finalReasoningContent);
        reasoningSent = true;
    }

    writeOpenAITextDelta(res, streamMeta.id, streamMeta.created, streamMeta.model, finalTextToSend);

    writeOpenAISSE(res, {
        id: streamMeta.id,
        object: 'chat.completion.chunk',
        created: streamMeta.created,
        model: streamMeta.model,
        choices: [{
            index: 0,
            delta: {},
            finish_reason: 'stop',
        }],
        usage: buildOpenAIUsage(anthropicReq, streamer.hasSentText() ? (finalVisibleText || finalRawResponse) : finalTextToSend),
    });

    log.recordRawResponse(finalRawResponse);
    if (finalReasoningContent) {
        log.recordThinking(finalReasoningContent);
    }
    const finalRecordedResponse = streamer.hasSentText()
        ? sanitizeResponse(finalVisibleText || finalRawResponse)
        : finalTextToSend;
    log.recordFinalResponse(finalRecordedResponse);
    log.complete(finalRecordedResponse.length, 'stop');

    res.write('data: [DONE]\n\n');
    res.end();
}

// ==================== 流式处理（OpenAI SSE 格式） ====================

async function handleOpenAIStream(
    res: Response,
    cursorReq: CursorChatRequest,
    body: OpenAIChatRequest,
    anthropicReq: AnthropicRequest,
    log: RequestLogger,
): Promise<void> {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    const id = chatId();
    const created = Math.floor(Date.now() / 1000);
    const model = body.model;
    const hasTools = (body.tools?.length ?? 0) > 0;

    // 发送 role delta
    writeOpenAISSE(res, {
        id, object: 'chat.completion.chunk', created, model,
        choices: [{
            index: 0,
            delta: { role: 'assistant', content: '' },
            finish_reason: null,
        }],
    });

    let fullResponse = '';
    let sentText = '';
    let activeCursorReq = cursorReq;
    let retryCount = 0;

    // 统一缓冲模式：先缓冲全部响应，再检测拒绝和处理
    const executeStream = async (onTextDelta?: (delta: string) => void) => {
        fullResponse = '';
        await sendCursorRequest(activeCursorReq, (event: CursorSSEEvent) => {
            if (event.type !== 'text-delta' || !event.delta) return;
            fullResponse += event.delta;
            onTextDelta?.(event.delta);
        });
    };

    try {
        if (!hasTools && (!body.response_format || body.response_format.type === 'text')) {
            await handleOpenAIIncrementalTextStream(res, cursorReq, body, anthropicReq, { id, created, model }, log);
            return;
        }

        // ★ 混合流式：文本增量 + 工具缓冲（与 Anthropic handler 同一设计）
        const thinkingEnabled = anthropicReq.thinking?.type === 'enabled';
        const hybridStreamer = createIncrementalTextStreamer({
            warmupChars: 300,   // ★ 与拒绝检测窗口对齐
            transform: sanitizeResponse,
            isBlockedPrefix: (text) => isRefusal(text.substring(0, 300)),
        });
        let toolMarkerDetected = false;
        let pendingText = '';
        let hybridThinkingContent = '';
        let hybridLeadingBuffer = '';
        let hybridLeadingResolved = false;
        const TOOL_MARKER = '```json action';
        const MARKER_LOOKBACK = TOOL_MARKER.length + 2;
        let hybridTextSent = false;
        let hybridReasoningSent = false;

        const pushToStreamer = (text: string): void => {
            if (!text || toolMarkerDetected) return;
            pendingText += text;
            const idx = pendingText.indexOf(TOOL_MARKER);
            if (idx >= 0) {
                const before = pendingText.substring(0, idx);
                if (before) {
                    const d = hybridStreamer.push(before);
                    if (d) {
                        if (thinkingEnabled && hybridThinkingContent && !hybridReasoningSent) {
                            writeOpenAIReasoningDelta(res, id, created, model, hybridThinkingContent);
                            hybridReasoningSent = true;
                        }
                        writeOpenAITextDelta(res, id, created, model, d);
                        hybridTextSent = true;
                    }
                }
                toolMarkerDetected = true;
                pendingText = '';
                return;
            }
            const safeEnd = pendingText.length - MARKER_LOOKBACK;
            if (safeEnd > 0) {
                const safe = pendingText.substring(0, safeEnd);
                pendingText = pendingText.substring(safeEnd);
                const d = hybridStreamer.push(safe);
                if (d) {
                    if (thinkingEnabled && hybridThinkingContent && !hybridReasoningSent) {
                        writeOpenAIReasoningDelta(res, id, created, model, hybridThinkingContent);
                        hybridReasoningSent = true;
                    }
                    writeOpenAITextDelta(res, id, created, model, d);
                    hybridTextSent = true;
                }
            }
        };

        const processHybridDelta = (delta: string): void => {
            if (!hybridLeadingResolved) {
                hybridLeadingBuffer += delta;
                const split = splitLeadingThinkingBlocks(hybridLeadingBuffer);
                if (split.startedWithThinking) {
                    if (!split.complete) return;
                    hybridThinkingContent = split.thinkingContent;
                    hybridLeadingResolved = true;
                    hybridLeadingBuffer = '';
                    pushToStreamer(split.remainder);
                    return;
                }
                if (hybridLeadingBuffer.trimStart().length < 10) return;
                hybridLeadingResolved = true;
                const buffered = hybridLeadingBuffer;
                hybridLeadingBuffer = '';
                pushToStreamer(buffered);
                return;
            }
            pushToStreamer(delta);
        };

        await executeStream(processHybridDelta);

        // flush 残留缓冲
        if (!hybridLeadingResolved && hybridLeadingBuffer) {
            hybridLeadingResolved = true;
            const split = splitLeadingThinkingBlocks(hybridLeadingBuffer);
            if (split.startedWithThinking && split.complete) {
                hybridThinkingContent = split.thinkingContent;
                pushToStreamer(split.remainder);
            } else if (split.startedWithThinking && !split.complete) {
                // ★ thinking 未闭合（输出被截断在 thinking 阶段）
                // 提取部分 thinking 内容，不 push 到正文流，避免泄漏
                hybridThinkingContent = split.thinkingContent;
                // remainder 为空，不 push 任何正文内容
            } else {
                pushToStreamer(hybridLeadingBuffer);
            }
        }
        if (pendingText && !toolMarkerDetected) {
            const d = hybridStreamer.push(pendingText);
            if (d) {
                if (thinkingEnabled && hybridThinkingContent && !hybridReasoningSent) {
                    writeOpenAIReasoningDelta(res, id, created, model, hybridThinkingContent);
                    hybridReasoningSent = true;
                }
                writeOpenAITextDelta(res, id, created, model, d);
                hybridTextSent = true;
            }
            pendingText = '';
        }
        const hybridRemaining = hybridStreamer.finish();
        if (hybridRemaining) {
            if (thinkingEnabled && hybridThinkingContent && !hybridReasoningSent) {
                writeOpenAIReasoningDelta(res, id, created, model, hybridThinkingContent);
                hybridReasoningSent = true;
            }
            writeOpenAITextDelta(res, id, created, model, hybridRemaining);
            hybridTextSent = true;
        }

        // ★ Thinking 提取（在拒绝检测之前）
        let reasoningContent: string | undefined = hybridThinkingContent || undefined;
        if (hasLeadingThinking(fullResponse)) {
            const { thinkingContent: extracted, strippedText } = extractThinking(fullResponse);
            if (extracted) {
                if (thinkingEnabled && !reasoningContent) {
                    reasoningContent = extracted;
                }
                fullResponse = strippedText;
            }
        }

        // 拒绝检测 + 自动重试
        const shouldRetryRefusal = () => {
            if (hybridTextSent) return false;  // 已发文字，不可重试
            if (!isRefusal(fullResponse)) return false;
            if (hasTools && hasToolCalls(fullResponse)) return false;
            return true;
        };

        while (shouldRetryRefusal() && retryCount < MAX_REFUSAL_RETRIES) {
            retryCount++;
            const retryBody = buildRetryRequest(anthropicReq, retryCount - 1);
            activeCursorReq = await convertToCursorRequest(retryBody);
            await executeStream();  // 重试不传回调
        }
        if (shouldRetryRefusal()) {
            if (!hasTools) {
                if (isToolCapabilityQuestion(anthropicReq)) {
                    fullResponse = CLAUDE_TOOLS_RESPONSE;
                } else {
                    fullResponse = CLAUDE_IDENTITY_RESPONSE;
                }
            } else {
                fullResponse = 'I understand the request. Let me analyze the information and proceed with the appropriate action.';
            }
        }

        // 极短响应重试
        if (hasTools && fullResponse.trim().length < 10 && retryCount < MAX_REFUSAL_RETRIES) {
            retryCount++;
            activeCursorReq = await convertToCursorRequest(anthropicReq);
            await executeStream();
        }

        if (hasTools) {
            fullResponse = await autoContinueCursorToolResponseStream(activeCursorReq, fullResponse, hasTools);
        }

        let finishReason: 'stop' | 'tool_calls' = 'stop';

        // ★ 发送 reasoning_content（仅在混合流式未发送时）
        if (reasoningContent && !hybridReasoningSent) {
            writeOpenAISSE(res, {
                id, object: 'chat.completion.chunk', created, model,
                choices: [{
                    index: 0,
                    delta: { reasoning_content: reasoningContent } as Record<string, unknown>,
                    finish_reason: null,
                }],
            });
        }

        if (hasTools && hasToolCalls(fullResponse)) {
            const { toolCalls, cleanText } = parseToolCalls(fullResponse);

            if (toolCalls.length > 0) {
                finishReason = 'tool_calls';
                log.recordToolCalls(toolCalls);
                log.updateSummary({ toolCallsDetected: toolCalls.length });

                // 发送工具调用前的残余文本 — 如果混合流式已发送则跳过
                if (!hybridTextSent) {
                    let cleanOutput = isRefusal(cleanText) ? '' : cleanText;
                    cleanOutput = sanitizeResponse(cleanOutput);
                    if (cleanOutput) {
                        writeOpenAISSE(res, {
                            id, object: 'chat.completion.chunk', created, model,
                            choices: [{
                                index: 0,
                                delta: { content: cleanOutput },
                                finish_reason: null,
                            }],
                        });
                    }
                }

                // 增量流式发送工具调用：先发 name+id，再分块发 arguments
                for (let i = 0; i < toolCalls.length; i++) {
                    const tc = toolCalls[i];
                    const tcId = toolCallId();
                    const argsStr = JSON.stringify(tc.arguments);

                    // 第一帧：发送 name + id， arguments 为空
                    writeOpenAISSE(res, {
                        id, object: 'chat.completion.chunk', created, model,
                        choices: [{
                            index: 0,
                            delta: {
                                ...(i === 0 ? { content: null } : {}),
                                tool_calls: [{
                                    index: i,
                                    id: tcId,
                                    type: 'function',
                                    function: { name: tc.name, arguments: '' },
                                }],
                            },
                            finish_reason: null,
                        }],
                    });

                    // 后续帧：分块发送 arguments (128 字节/帧)
                    const CHUNK_SIZE = 128;
                    for (let j = 0; j < argsStr.length; j += CHUNK_SIZE) {
                        writeOpenAISSE(res, {
                            id, object: 'chat.completion.chunk', created, model,
                            choices: [{
                                index: 0,
                                delta: {
                                    tool_calls: [{
                                        index: i,
                                        function: { arguments: argsStr.slice(j, j + CHUNK_SIZE) },
                                    }],
                                },
                                finish_reason: null,
                            }],
                        });
                    }
                }
            } else {
                // 误报：发送清洗后的文本（如果混合流式未发送）
                if (!hybridTextSent) {
                    let textToSend = fullResponse;
                    if (isRefusal(fullResponse)) {
                        textToSend = 'I understand the request. Let me proceed with the appropriate action. Could you clarify what specific task you would like me to perform?';
                    } else {
                        textToSend = sanitizeResponse(fullResponse);
                    }
                    writeOpenAISSE(res, {
                        id, object: 'chat.completion.chunk', created, model,
                        choices: [{
                            index: 0,
                            delta: { content: textToSend },
                            finish_reason: null,
                        }],
                    });
                }
            }
        } else {
            // 无工具模式或无工具调用 — 如果混合流式未发送则统一清洗后发送
            if (!hybridTextSent) {
                let sanitized = sanitizeResponse(fullResponse);
                // ★ response_format 后处理：剥离 markdown 代码块包裹
                if (body.response_format && body.response_format.type !== 'text') {
                    sanitized = stripMarkdownJsonWrapper(sanitized);
                }
                if (sanitized) {
                    writeOpenAISSE(res, {
                        id, object: 'chat.completion.chunk', created, model,
                        choices: [{
                            index: 0,
                            delta: { content: sanitized },
                            finish_reason: null,
                        }],
                    });
                }
            }
        }

        // 发送完成 chunk（带 usage，兼容依赖最终 usage 帧的 OpenAI 客户端/代理）
        writeOpenAISSE(res, {
            id, object: 'chat.completion.chunk', created, model,
            choices: [{
                index: 0,
                delta: {},
                finish_reason: finishReason,
            }],
            usage: buildOpenAIUsage(anthropicReq, fullResponse),
        });

        log.recordRawResponse(fullResponse);
        if (reasoningContent) {
            log.recordThinking(reasoningContent);
        }
        log.recordFinalResponse(fullResponse);
        log.complete(fullResponse.length, finishReason);

        res.write('data: [DONE]\n\n');

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.fail(message);
        writeOpenAISSE(res, {
            id, object: 'chat.completion.chunk', created, model,
            choices: [{
                index: 0,
                delta: { content: `\n\n[Error: ${message}]` },
                finish_reason: 'stop',
            }],
        });
        res.write('data: [DONE]\n\n');
    }

    res.end();
}

// ==================== 非流式处理 ====================

async function handleOpenAINonStream(
    res: Response,
    cursorReq: CursorChatRequest,
    body: OpenAIChatRequest,
    anthropicReq: AnthropicRequest,
    log: RequestLogger,
): Promise<void> {
    let activeCursorReq = cursorReq;
    let fullText = (await sendCursorRequestFull(activeCursorReq)).text;
    const hasTools = (body.tools?.length ?? 0) > 0;

    // 日志记录在详细日志中

    // ★ Thinking 提取必须在拒绝检测之前 — 否则 thinking 内容中的关键词会触发 isRefusal 误判
    const thinkingEnabled = anthropicReq.thinking?.type === 'enabled';
    let reasoningContent: string | undefined;
    if (hasLeadingThinking(fullText)) {
        const { thinkingContent: extracted, strippedText } = extractThinking(fullText);
        if (extracted) {
            if (thinkingEnabled) {
                reasoningContent = extracted;
            }
            // thinking 剥离记录
            fullText = strippedText;
        }
    }

    // 拒绝检测 + 自动重试（在 thinking 提取之后，只检测实际输出内容）
    const shouldRetry = () => isRefusal(fullText) && !(hasTools && hasToolCalls(fullText));

    if (shouldRetry()) {
        for (let attempt = 0; attempt < MAX_REFUSAL_RETRIES; attempt++) {
            // 重试记录
            const retryBody = buildRetryRequest(anthropicReq, attempt);
            const retryCursorReq = await convertToCursorRequest(retryBody);
            activeCursorReq = retryCursorReq;
            fullText = (await sendCursorRequestFull(activeCursorReq)).text;
            // 重试响应也需要先剥离 thinking
            if (hasLeadingThinking(fullText)) {
                fullText = extractThinking(fullText).strippedText;
            }
            if (!shouldRetry()) break;
        }
        if (shouldRetry()) {
            if (hasTools) {
                // 记录在详细日志
                fullText = 'I understand the request. Let me analyze the information and proceed with the appropriate action.';
            } else if (isToolCapabilityQuestion(anthropicReq)) {
                // 记录在详细日志
                fullText = CLAUDE_TOOLS_RESPONSE;
            } else {
                // 记录在详细日志
                fullText = CLAUDE_IDENTITY_RESPONSE;
            }
        }
    }

    if (hasTools) {
        fullText = await autoContinueCursorToolResponseFull(activeCursorReq, fullText, hasTools);
    }

    let content: string | null = fullText;
    let toolCalls: OpenAIToolCall[] | undefined;
    let finishReason: 'stop' | 'tool_calls' = 'stop';

    if (hasTools) {
        const parsed = parseToolCalls(fullText);

        if (parsed.toolCalls.length > 0) {
            finishReason = 'tool_calls';
            log.recordToolCalls(parsed.toolCalls);
            log.updateSummary({ toolCallsDetected: parsed.toolCalls.length });
            // 清洗拒绝文本
            let cleanText = parsed.cleanText;
            if (isRefusal(cleanText)) {
                // 记录在详细日志
                cleanText = '';
            }
            content = sanitizeResponse(cleanText) || null;

            toolCalls = parsed.toolCalls.map(tc => ({
                id: toolCallId(),
                type: 'function' as const,
                function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments),
                },
            }));
        } else {
            // 无工具调用，检查拒绝
            if (isRefusal(fullText)) {
                content = 'I understand the request. Let me proceed with the appropriate action. Could you clarify what specific task you would like me to perform?';
            } else {
                content = sanitizeResponse(fullText);
            }
        }
    } else {
        // 无工具模式：清洗响应
        content = sanitizeResponse(fullText);
        // ★ response_format 后处理：剥离 markdown 代码块包裹
        if (body.response_format && body.response_format.type !== 'text' && content) {
            content = stripMarkdownJsonWrapper(content);
        }
    }

    const response: OpenAIChatCompletion = {
        id: chatId(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content,
                ...(toolCalls ? { tool_calls: toolCalls } : {}),
                ...(reasoningContent ? { reasoning_content: reasoningContent } as Record<string, unknown> : {}),
            },
            finish_reason: finishReason,
        }],
        usage: buildOpenAIUsage(anthropicReq, fullText),
    };

    res.json(response);

    log.recordRawResponse(fullText);
    if (reasoningContent) {
        log.recordThinking(reasoningContent);
    }
    log.recordFinalResponse(fullText);
    log.complete(fullText.length, finishReason);
}

// ==================== 工具函数 ====================

/**
 * 剥离 Markdown 代码块包裹，返回裸 JSON 字符串
 * 处理 ```json\n...\n``` 和 ```\n...\n``` 两种格式
 */
function stripMarkdownJsonWrapper(text: string): string {
    if (!text) return text;
    const trimmed = text.trim();
    const match = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n\s*```$/);
    if (match) {
        return match[1].trim();
    }
    return text;
}

function writeOpenAISSE(res: Response, data: OpenAIChatCompletionChunk): void {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (typeof (res as unknown as { flush: () => void }).flush === 'function') {
        (res as unknown as { flush: () => void }).flush();
    }
}

// ==================== /v1/responses 支持 ====================

/**
 * 写入 Responses API SSE 事件
 * 格式：event: {eventType}\ndata: {json}\n\n
 * 注意：与 Chat Completions 的 "data: {json}\n\n" 不同，Responses API 需要 event: 前缀
 */
function writeResponsesSSE(res: Response, eventType: string, data: Record<string, unknown>): void {
    res.write(`event: ${eventType}\ndata: ${JSON.stringify({ type: eventType, ...data })}\n\n`);
    if (typeof (res as unknown as { flush: () => void }).flush === 'function') {
        (res as unknown as { flush: () => void }).flush();
    }
}

function responsesId(): string {
    return 'resp_' + uuidv4().replace(/-/g, '').substring(0, 24);
}

function responsesItemId(): string {
    return 'item_' + uuidv4().replace(/-/g, '').substring(0, 24);
}

/**
 * 构建 Responses API 的 response 对象骨架
 */
function buildResponseObject(
    id: string,
    model: string,
    status: 'in_progress' | 'completed',
    output: Record<string, unknown>[],
    usage?: { input_tokens: number; output_tokens: number; total_tokens: number },
): Record<string, unknown> {
    return {
        id,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status,
        model,
        output,
        ...(usage ? { usage } : {}),
    };
}

/**
 * 处理 OpenAI Codex / Responses API 的 /v1/responses 请求
 *
 * ★ 关键差异：Responses API 的流式格式与 Chat Completions 完全不同
 * Codex 期望接收 event: response.created / response.output_text.delta / response.completed 等事件
 * 而非 data: {"object":"chat.completion.chunk",...} 格式
 */
export async function handleOpenAIResponses(req: Request, res: Response): Promise<void> {
    const body = req.body as Record<string, unknown>;
    const isStream = (body.stream as boolean) ?? true;
    const chatBody = responsesToChatCompletions(body);
    const log = createRequestLogger({
        method: req.method,
        path: req.path,
        model: chatBody.model,
        stream: isStream,
        hasTools: (chatBody.tools?.length ?? 0) > 0,
        toolCount: chatBody.tools?.length ?? 0,
        messageCount: chatBody.messages?.length ?? 0,
        apiFormat: 'responses',
    });
    log.startPhase('receive', '接收请求');
    log.recordOriginalRequest(body);
    log.info('OpenAI', 'receive', '收到 OpenAI Responses 请求', {
        model: chatBody.model,
        stream: isStream,
        toolCount: chatBody.tools?.length ?? 0,
        messageCount: chatBody.messages?.length ?? 0,
    });

    try {
        // Step 1: 转换请求格式 Responses → Chat Completions → Anthropic → Cursor
        log.startPhase('convert', '格式转换 (Responses→Chat→Anthropic)');
        const anthropicReq = convertToAnthropicRequest(chatBody);
        const cursorReq = await convertToCursorRequest(anthropicReq);
        log.endPhase();
        log.recordCursorRequest(cursorReq);

        // 身份探针拦截
        if (isIdentityProbe(anthropicReq)) {
            log.intercepted('身份探针拦截 (Responses)');
            const mockText = "I am Claude, an advanced AI programming assistant created by Anthropic. I am ready to help you write code, debug, and answer your technical questions.";
            if (isStream) {
                return handleResponsesStreamMock(res, body, mockText);
            } else {
                return handleResponsesNonStreamMock(res, body, mockText);
            }
        }

        if (isStream) {
            await handleResponsesStream(res, cursorReq, body, anthropicReq, log);
        } else {
            await handleResponsesNonStream(res, cursorReq, body, anthropicReq, log);
        }
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.fail(message);
        console.error(`[OpenAI] /v1/responses 处理失败:`, message);
        const status = err instanceof OpenAIRequestError ? err.status : 500;
        const type = err instanceof OpenAIRequestError ? err.type : 'server_error';
        const code = err instanceof OpenAIRequestError ? err.code : 'internal_error';
        res.status(status).json({
            error: { message, type, code },
        });
    }
}

/**
 * 模拟身份响应 — 流式 (Responses API SSE 格式)
 */
function handleResponsesStreamMock(res: Response, body: Record<string, unknown>, mockText: string): void {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    const respId = responsesId();
    const itemId = responsesItemId();
    const model = (body.model as string) || 'gpt-4';

    emitResponsesTextStream(res, respId, itemId, model, mockText, 0, { input_tokens: 15, output_tokens: 35, total_tokens: 50 });
    res.end();
}

/**
 * 模拟身份响应 — 非流式 (Responses API JSON 格式)
 */
function handleResponsesNonStreamMock(res: Response, body: Record<string, unknown>, mockText: string): void {
    const respId = responsesId();
    const itemId = responsesItemId();
    const model = (body.model as string) || 'gpt-4';

    res.json(buildResponseObject(respId, model, 'completed', [{
        id: itemId,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: mockText, annotations: [] }],
    }], { input_tokens: 15, output_tokens: 35, total_tokens: 50 }));
}

/**
 * 发射完整的 Responses API 文本流事件序列
 * 包含从 response.created 到 response.completed 的完整生命周期
 */
function emitResponsesTextStream(
    res: Response,
    respId: string,
    itemId: string,
    model: string,
    fullText: string,
    outputIndex: number,
    usage: { input_tokens: number; output_tokens: number; total_tokens: number },
    toolCallItems?: Record<string, unknown>[],
): void {
    // 所有输出项（文本 + 工具调用）
    const messageItem: Record<string, unknown> = {
        id: itemId,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: fullText, annotations: [] }],
    };
    const allOutputItems = toolCallItems ? [...toolCallItems, messageItem] : [messageItem];

    // 1. response.created
    writeResponsesSSE(res, 'response.created', { response: buildResponseObject(respId, model, 'in_progress', []) });

    // 2. response.in_progress
    writeResponsesSSE(res, 'response.in_progress', { response: buildResponseObject(respId, model, 'in_progress', []) });

    // 3. 文本 output item
    writeResponsesSSE(res, 'response.output_item.added', {
        output_index: outputIndex,
        item: {
            id: itemId,
            type: 'message',
            role: 'assistant',
            status: 'in_progress',
            content: [],
        },
    });

    // 4. content part
    writeResponsesSSE(res, 'response.content_part.added', {
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
    });

    // 5. 文本增量
    if (fullText) {
        // 分块发送，模拟流式体验 (每块约 100 字符)
        const CHUNK_SIZE = 100;
        for (let i = 0; i < fullText.length; i += CHUNK_SIZE) {
            writeResponsesSSE(res, 'response.output_text.delta', {
                output_index: outputIndex,
                content_index: 0,
                delta: fullText.slice(i, i + CHUNK_SIZE),
            });
        }
    }

    // 6. response.output_text.done
    writeResponsesSSE(res, 'response.output_text.done', {
        output_index: outputIndex,
        content_index: 0,
        text: fullText,
    });

    // 7. response.content_part.done
    writeResponsesSSE(res, 'response.content_part.done', {
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: fullText, annotations: [] },
    });

    // 8. response.output_item.done (message)
    writeResponsesSSE(res, 'response.output_item.done', {
        output_index: outputIndex,
        item: messageItem,
    });

    // 9. response.completed — ★ 这是 Codex 等待的关键事件
    writeResponsesSSE(res, 'response.completed', { response: buildResponseObject(respId, model, 'completed', allOutputItems, usage) });
}

/**
 * Responses API 流式处理
 *
 * ★ 与 Chat Completions 流式的核心区别：
 * 1. 使用 event: 前缀的 SSE 事件（不是 data-only）
 * 2. 必须发送 response.completed 事件，否则 Codex 报 "stream closed before response.completed"
 * 3. 工具调用用 function_call 类型的 output item 表示
 */
async function handleResponsesStream(
    res: Response,
    cursorReq: CursorChatRequest,
    body: Record<string, unknown>,
    anthropicReq: AnthropicRequest,
    log: RequestLogger,
): Promise<void> {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    const respId = responsesId();
    const model = (body.model as string) || 'gpt-4';
    const hasTools = (anthropicReq.tools?.length ?? 0) > 0;
    let toolCallsDetected = 0;

    // 缓冲完整响应再处理（复用 Chat Completions 的逻辑）
    let fullResponse = '';
    let activeCursorReq = cursorReq;
    let retryCount = 0;

    // ★ 流式保活：防止网关 504
    const keepaliveInterval = setInterval(() => {
        try {
            res.write(': keepalive\n\n');
            if (typeof (res as unknown as { flush: () => void }).flush === 'function') {
                (res as unknown as { flush: () => void }).flush();
            }
        } catch { /* connection already closed */ }
    }, 15000);

    try {
        const executeStream = async () => {
            fullResponse = '';
            await sendCursorRequest(activeCursorReq, (event: CursorSSEEvent) => {
                if (event.type !== 'text-delta' || !event.delta) return;
                fullResponse += event.delta;
            });
        };

        await executeStream();

        // Thinking 提取
        if (hasLeadingThinking(fullResponse)) {
            const { strippedText } = extractThinking(fullResponse);
            fullResponse = strippedText;
        }

        // 拒绝检测 + 自动重试
        const shouldRetryRefusal = () => {
            if (!isRefusal(fullResponse)) return false;
            if (hasTools && hasToolCalls(fullResponse)) return false;
            return true;
        };

        while (shouldRetryRefusal() && retryCount < MAX_REFUSAL_RETRIES) {
            retryCount++;
            const retryBody = buildRetryRequest(anthropicReq, retryCount - 1);
            activeCursorReq = await convertToCursorRequest(retryBody);
            await executeStream();
            if (hasLeadingThinking(fullResponse)) {
                fullResponse = extractThinking(fullResponse).strippedText;
            }
        }

        if (shouldRetryRefusal()) {
            if (isToolCapabilityQuestion(anthropicReq)) {
                fullResponse = CLAUDE_TOOLS_RESPONSE;
            } else {
                fullResponse = CLAUDE_IDENTITY_RESPONSE;
            }
        }

        if (hasTools) {
            fullResponse = await autoContinueCursorToolResponseStream(activeCursorReq, fullResponse, hasTools);
        }

        // 清洗响应
        fullResponse = sanitizeResponse(fullResponse);

        // 计算 usage
        const inputTokens = estimateInputTokens(anthropicReq);
        const outputTokens = Math.ceil(fullResponse.length / 3);
        const usage = { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens };

        // ★ 工具调用解析 + Responses API 格式输出
        if (hasTools && hasToolCalls(fullResponse)) {
            const { toolCalls, cleanText } = parseToolCalls(fullResponse);

            if (toolCalls.length > 0) {
                toolCallsDetected = toolCalls.length;
                log.recordToolCalls(toolCalls);
                log.updateSummary({ toolCallsDetected: toolCalls.length });
                // 1. response.created + response.in_progress
                writeResponsesSSE(res, 'response.created', { response: buildResponseObject(respId, model, 'in_progress', []) });
                writeResponsesSSE(res, 'response.in_progress', { response: buildResponseObject(respId, model, 'in_progress', []) });

                const allOutputItems: Record<string, unknown>[] = [];
                let outputIndex = 0;

                // 2. 每个工具调用 → function_call output item
                for (const tc of toolCalls) {
                    const callId = toolCallId();
                    const fcItemId = responsesItemId();
                    const argsStr = JSON.stringify(tc.arguments);

                    // output_item.added (function_call)
                    writeResponsesSSE(res, 'response.output_item.added', {
                        output_index: outputIndex,
                        item: {
                            id: fcItemId,
                            type: 'function_call',
                            name: tc.name,
                            call_id: callId,
                            arguments: '',
                            status: 'in_progress',
                        },
                    });

                    // function_call_arguments.delta — 分块发送
                    const CHUNK_SIZE = 128;
                    for (let j = 0; j < argsStr.length; j += CHUNK_SIZE) {
                        writeResponsesSSE(res, 'response.function_call_arguments.delta', {
                            output_index: outputIndex,
                            delta: argsStr.slice(j, j + CHUNK_SIZE),
                        });
                    }

                    // function_call_arguments.done
                    writeResponsesSSE(res, 'response.function_call_arguments.done', {
                        output_index: outputIndex,
                        arguments: argsStr,
                    });

                    // output_item.done (function_call)
                    const completedFcItem = {
                        id: fcItemId,
                        type: 'function_call',
                        name: tc.name,
                        call_id: callId,
                        arguments: argsStr,
                        status: 'completed',
                    };
                    writeResponsesSSE(res, 'response.output_item.done', {
                        output_index: outputIndex,
                        item: completedFcItem,
                    });

                    allOutputItems.push(completedFcItem);
                    outputIndex++;
                }

                // 3. 如果有纯文本部分，也发送 message output item
                let textContent = sanitizeResponse(isRefusal(cleanText) ? '' : cleanText);
                if (textContent) {
                    const msgItemId = responsesItemId();
                    writeResponsesSSE(res, 'response.output_item.added', {
                        output_index: outputIndex,
                        item: { id: msgItemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
                    });
                    writeResponsesSSE(res, 'response.content_part.added', {
                        output_index: outputIndex, content_index: 0,
                        part: { type: 'output_text', text: '', annotations: [] },
                    });
                    writeResponsesSSE(res, 'response.output_text.delta', {
                        output_index: outputIndex, content_index: 0, delta: textContent,
                    });
                    writeResponsesSSE(res, 'response.output_text.done', {
                        output_index: outputIndex, content_index: 0, text: textContent,
                    });
                    writeResponsesSSE(res, 'response.content_part.done', {
                        output_index: outputIndex, content_index: 0,
                        part: { type: 'output_text', text: textContent, annotations: [] },
                    });
                    const msgItem = {
                        id: msgItemId, type: 'message', role: 'assistant', status: 'completed',
                        content: [{ type: 'output_text', text: textContent, annotations: [] }],
                    };
                    writeResponsesSSE(res, 'response.output_item.done', { output_index: outputIndex, item: msgItem });
                    allOutputItems.push(msgItem);
                }

                // 4. response.completed — ★ Codex 等待的关键事件
                writeResponsesSSE(res, 'response.completed', { response: buildResponseObject(respId, model, 'completed', allOutputItems, usage) });
            } else {
                // 工具调用解析失败（误报）→ 作为纯文本发送
                const msgItemId = responsesItemId();
                emitResponsesTextStream(res, respId, msgItemId, model, fullResponse, 0, usage);
            }
        } else {
            // 纯文本响应
            const msgItemId = responsesItemId();
            emitResponsesTextStream(res, respId, msgItemId, model, fullResponse, 0, usage);
        }
        log.recordRawResponse(fullResponse);
        log.recordFinalResponse(fullResponse);
        log.complete(fullResponse.length, toolCallsDetected > 0 ? 'tool_calls' : 'stop');
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.fail(message);
        // 尝试发送错误后的 response.completed，确保 Codex 不会等待超时
        try {
            const errorText = `[Error: ${message}]`;
            const errorItemId = responsesItemId();
            writeResponsesSSE(res, 'response.created', { response: buildResponseObject(respId, model, 'in_progress', []) });
            writeResponsesSSE(res, 'response.output_item.added', {
                output_index: 0,
                item: { id: errorItemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
            });
            writeResponsesSSE(res, 'response.content_part.added', {
                output_index: 0, content_index: 0,
                part: { type: 'output_text', text: '', annotations: [] },
            });
            writeResponsesSSE(res, 'response.output_text.delta', {
                output_index: 0, content_index: 0, delta: errorText,
            });
            writeResponsesSSE(res, 'response.output_text.done', {
                output_index: 0, content_index: 0, text: errorText,
            });
            writeResponsesSSE(res, 'response.content_part.done', {
                output_index: 0, content_index: 0,
                part: { type: 'output_text', text: errorText, annotations: [] },
            });
            writeResponsesSSE(res, 'response.output_item.done', {
                output_index: 0,
                item: { id: errorItemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: errorText, annotations: [] }] },
            });
            writeResponsesSSE(res, 'response.completed', { response: buildResponseObject(respId, model, 'completed', [{
                id: errorItemId, type: 'message', role: 'assistant', status: 'completed',
                content: [{ type: 'output_text', text: errorText, annotations: [] }],
            }], { input_tokens: 0, output_tokens: 10, total_tokens: 10 }) });
        } catch { /* ignore double error */ }
    } finally {
        clearInterval(keepaliveInterval);
    }

    res.end();
}

/**
 * Responses API 非流式处理
 */
async function handleResponsesNonStream(
    res: Response,
    cursorReq: CursorChatRequest,
    body: Record<string, unknown>,
    anthropicReq: AnthropicRequest,
    log: RequestLogger,
): Promise<void> {
    let activeCursorReq = cursorReq;
    let fullText = (await sendCursorRequestFull(activeCursorReq)).text;
    const hasTools = (anthropicReq.tools?.length ?? 0) > 0;

    // Thinking 提取
    if (hasLeadingThinking(fullText)) {
        fullText = extractThinking(fullText).strippedText;
    }

    // 拒绝检测 + 重试
    const shouldRetry = () => isRefusal(fullText) && !(hasTools && hasToolCalls(fullText));
    if (shouldRetry()) {
        for (let attempt = 0; attempt < MAX_REFUSAL_RETRIES; attempt++) {
            const retryBody = buildRetryRequest(anthropicReq, attempt);
            const retryCursorReq = await convertToCursorRequest(retryBody);
            activeCursorReq = retryCursorReq;
            fullText = (await sendCursorRequestFull(activeCursorReq)).text;
            if (hasLeadingThinking(fullText)) {
                fullText = extractThinking(fullText).strippedText;
            }
            if (!shouldRetry()) break;
        }
        if (shouldRetry()) {
            if (isToolCapabilityQuestion(anthropicReq)) {
                fullText = CLAUDE_TOOLS_RESPONSE;
            } else {
                fullText = CLAUDE_IDENTITY_RESPONSE;
            }
        }
    }

    if (hasTools) {
        fullText = await autoContinueCursorToolResponseFull(activeCursorReq, fullText, hasTools);
    }

    fullText = sanitizeResponse(fullText);

    const respId = responsesId();
    const model = (body.model as string) || 'gpt-4';
    const inputTokens = estimateInputTokens(anthropicReq);
    const outputTokens = Math.ceil(fullText.length / 3);
    const usage = { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens };

    const output: Record<string, unknown>[] = [];
    let toolCallsDetected = 0;

    if (hasTools && hasToolCalls(fullText)) {
        const { toolCalls, cleanText } = parseToolCalls(fullText);
        toolCallsDetected = toolCalls.length;
        log.recordToolCalls(toolCalls);
        log.updateSummary({ toolCallsDetected: toolCalls.length });
        for (const tc of toolCalls) {
            output.push({
                id: responsesItemId(),
                type: 'function_call',
                name: tc.name,
                call_id: toolCallId(),
                arguments: JSON.stringify(tc.arguments),
                status: 'completed',
            });
        }
        const textContent = sanitizeResponse(isRefusal(cleanText) ? '' : cleanText);
        if (textContent) {
            output.push({
                id: responsesItemId(),
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: textContent, annotations: [] }],
            });
        }
    } else {
        output.push({
            id: responsesItemId(),
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: fullText, annotations: [] }],
        });
    }

    res.json(buildResponseObject(respId, model, 'completed', output, usage));

    log.recordRawResponse(fullText);
    log.recordFinalResponse(fullText);
    log.complete(fullText.length, toolCallsDetected > 0 ? 'tool_calls' : 'stop');
}

/**
 * 将 OpenAI Responses API 格式转换为 Chat Completions 格式
 *
 * Responses API 使用 `input` 而非 `messages`，格式与 Chat Completions 不同
 */
export function responsesToChatCompletions(body: Record<string, unknown>): OpenAIChatRequest {
    const messages: OpenAIMessage[] = [];

    // 系统指令
    if (body.instructions && typeof body.instructions === 'string') {
        messages.push({ role: 'system', content: body.instructions });
    }

    // 转换 input
    const input = body.input;
    if (typeof input === 'string') {
        messages.push({ role: 'user', content: input });
    } else if (Array.isArray(input)) {
        for (const item of input as Record<string, unknown>[]) {
            // function_call_output 没有 role 字段，必须先检查 type
            if (item.type === 'function_call_output') {
                messages.push({
                    role: 'tool',
                    content: stringifyUnknownContent(item.output),
                    tool_call_id: (item.call_id as string) || '',
                });
                continue;
            }
            const role = (item.role as string) || 'user';
            if (role === 'system' || role === 'developer') {
                const text = extractOpenAIContent({
                    role: 'system',
                    content: (item.content as string | OpenAIContentPart[] | null) ?? null,
                } as OpenAIMessage);
                messages.push({ role: 'system', content: text });
            } else if (role === 'user') {
                const rawContent = (item.content as string | OpenAIContentPart[] | null) ?? null;
                const normalizedContent = typeof rawContent === 'string'
                    ? rawContent
                    : Array.isArray(rawContent) && rawContent.every(b => b.type === 'input_text')
                        ? rawContent.map(b => b.text || '').join('\n')
                        : rawContent;
                messages.push({
                    role: 'user',
                    content: normalizedContent || '',
                });
            } else if (role === 'assistant') {
                const blocks = Array.isArray(item.content) ? item.content as Array<Record<string, unknown>> : [];
                const text = blocks.filter(b => b.type === 'output_text').map(b => b.text as string).join('\n');
                // 检查是否有工具调用
                const toolCallBlocks = blocks.filter(b => b.type === 'function_call');
                const toolCalls: OpenAIToolCall[] = toolCallBlocks.map(b => ({
                    id: (b.call_id as string) || toolCallId(),
                    type: 'function' as const,
                    function: {
                        name: (b.name as string) || '',
                        arguments: (b.arguments as string) || '{}',
                    },
                }));
                messages.push({
                    role: 'assistant',
                    content: text || null,
                    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
                });
            }
        }
    }

    // 转换工具定义
    const tools: OpenAITool[] | undefined = Array.isArray(body.tools)
        ? (body.tools as Array<Record<string, unknown>>).map(t => {
            if (t.type === 'function') {
                return {
                    type: 'function' as const,
                    function: {
                        name: (t.name as string) || '',
                        description: t.description as string | undefined,
                        parameters: t.parameters as Record<string, unknown> | undefined,
                    },
                };
            }
            return {
                type: 'function' as const,
                function: {
                    name: (t.name as string) || '',
                    description: t.description as string | undefined,
                    parameters: t.parameters as Record<string, unknown> | undefined,
                },
            };
        })
        : undefined;

    return {
        model: (body.model as string) || 'gpt-4',
        messages,
        stream: (body.stream as boolean) ?? true,
        temperature: body.temperature as number | undefined,
        max_tokens: (body.max_output_tokens as number) || 8192,
        tools,
    };
}
