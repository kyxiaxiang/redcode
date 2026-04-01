/**
 * constants.ts - 全局常量定义
 *
 * 集中管理拒绝检测规则、身份探针模式、固定回复模板等常量。
 * 方便查阅和修改内置规则，无需翻阅 handler.ts 的业务逻辑。
 */

import { getConfig } from './config.js';

// ==================== 拒绝模式识别 ====================
// 模型返回以下任意模式匹配的内容时，判定为拒绝响应并触发重试
// 如需添加新规则，请追加到对应分类末尾，或通过 config.yaml 的 refusal_patterns 配置

export const REFUSAL_PATTERNS: RegExp[] = [
    // ── English: 身份拒绝 ──
    /Cursor(?:'s)?\s+support\s+assistant/i,
    /support\s+assistant\s+for\s+Cursor/i,
    /I[''']\s*m\s+sorry/i,
    /I\s+am\s+sorry/i,
    /not\s+able\s+to\s+fulfill/i,
    /cannot\s+perform/i,
    /I\s+can\s+only\s+answer/i,
    /I\s+only\s+answer/i,
    /cannot\s+write\s+files/i,
    /pricing[, \s]*or\s*troubleshooting/i,
    /I\s+cannot\s+help\s+with/i,
    /I'm\s+a\s+coding\s+assistant/i,
    /not\s+able\s+to\s+search/i,
    /not\s+in\s+my\s+core/i,
    /outside\s+my\s+capabilities/i,
    /I\s+cannot\s+search/i,
    /focused\s+on\s+software\s+development/i,
    /not\s+able\s+to\s+help\s+with\s+(?:that|this)/i,
    /beyond\s+(?:my|the)\s+scope/i,
    /I'?m\s+not\s+(?:able|designed)\s+to/i,
    /I\s+don't\s+have\s+(?:the\s+)?(?:ability|capability)/i,
    /questions\s+about\s+(?:Cursor|the\s+(?:AI\s+)?code\s+editor)/i,

    // ── English: 话题拒绝 ── Cursor 拒绝非编程话题
    /help\s+with\s+(?:coding|programming)\s+and\s+Cursor/i,
    /Cursor\s+IDE\s+(?:questions|features|related)/i,
    /unrelated\s+to\s+(?:programming|coding)(?:\s+or\s+Cursor)?/i,
    /Cursor[- ]related\s+question/i,
    /(?:ask|please\s+ask)\s+a\s+(?:programming|coding|Cursor)/i,
    /(?:I'?m|I\s+am)\s+here\s+to\s+help\s+with\s+(?:coding|programming)/i,
    /appears\s+to\s+be\s+(?:asking|about)\s+.*?unrelated/i,
    /(?:not|isn't|is\s+not)\s+(?:related|relevant)\s+to\s+(?:programming|coding|software)/i,
    /I\s+can\s+help\s+(?:you\s+)?with\s+things\s+like/i,

    // ── English: 新拒绝措辞 (2026-03) ──
    /isn't\s+something\s+I\s+can\s+help\s+with/i,
    /not\s+something\s+I\s+can\s+help\s+with/i,
    /scoped\s+to\s+answering\s+questions\s+about\s+Cursor/i,
    /falls\s+outside\s+(?:the\s+scope|what\s+I)/i,

    // ── English: 提示注入/社会工程检测 ──
    /prompt\s+injection\s+attack/i,
    /prompt\s+injection/i,
    /social\s+engineering/i,
    /I\s+need\s+to\s+stop\s+and\s+flag/i,
    /What\s+I\s+will\s+not\s+do/i,
    /What\s+is\s+actually\s+happening/i,
    /replayed\s+against\s+a\s+real\s+system/i,
    /tool-call\s+payloads/i,
    /copy-pasteable\s+JSON/i,
    /injected\s+into\s+another\s+AI/i,
    /emit\s+tool\s+invocations/i,
    /make\s+me\s+output\s+tool\s+calls/i,

    // ── English: 工具可用性声明 (Cursor 角色锁定) ──
    /I\s+(?:only\s+)?have\s+(?:access\s+to\s+)?(?:two|2|read_file|read_dir)\s+tool/i,
    /(?:only|just)\s+(?:two|2)\s+(?:tools?|functions?)\b/i,
    /\bread_file\b.*\bread_dir\b/i,
    /\bread_dir\b.*\bread_file\b/i,

    // ── English: 范围/专长措辞 (2026-03 批次) ──
    /(?:outside|beyond)\s+(?:the\s+)?scope\s+of\s+what/i,
    /not\s+(?:within|in)\s+(?:my|the)\s+scope/i,
    /this\s+assistant\s+is\s+(?:focused|scoped)/i,
    /(?:only|just)\s+(?:able|here)\s+to\s+(?:answer|help)/i,
    /I\s+(?:can\s+)?only\s+help\s+with\s+(?:questions|issues)\s+(?:related|about)/i,
    /(?:here|designed)\s+to\s+help\s+(?:with\s+)?(?:questions\s+)?about\s+Cursor/i,
    /not\s+(?:something|a\s+topic)\s+(?:related|specific)\s+to\s+(?:Cursor|coding)/i,
    /outside\s+(?:my|the|your)\s+area\s+of\s+(?:expertise|scope)/i,
    /(?:can[.']?t|cannot|unable\s+to)\s+help\s+with\s+(?:this|that)\s+(?:request|question|topic)/i,
    /scoped\s+to\s+(?:answering|helping)/i,

    // ── English: Cursor support assistant context leak (2026-03) ──
    /currently\s+in\s+(?:the\s+)?Cursor\s+(?:support\s+)?(?:assistant\s+)?context/i,
    /it\s+appears\s+I['']?m\s+currently\s+in\s+the\s+Cursor/i,

    // ── 中文: 身份拒绝 ──
    /我是\s*Cursor\s*的?\s*支持助手/,
    /Cursor\s*的?\s*支持系统/,
    /Cursor\s*(?:编辑器|IDE)?\s*相关的?\s*问题/,
    /我的职责是帮助你解答/,
    /我无法透露/,
    /帮助你解答\s*Cursor/,
    /运行在\s*Cursor\s*的/,
    /专门.*回答.*(?:Cursor|编辑器)/,
    /我只能回答/,
    /无法提供.*信息/,
    /我没有.*也不会提供/,
    /功能使用[、,]\s*账单/,
    /故障排除/,

    // ── 中文: 话题拒绝 ──
    /与\s*(?:编程|代码|开发)\s*无关/,
    /请提问.*(?:编程|代码|开发|技术).*问题/,
    /只能帮助.*(?:编程|代码|开发)/,

    // ── 中文: 提示注入检测 ──
    /不是.*需要文档化/,
    /工具调用场景/,
    /语言偏好请求/,
    /提供.*具体场景/,
    /即报错/,

    // ── 中文: 工具可用性声明 ──
    /有以下.*?(?:两|2)个.*?工具/,
    /我有.*?(?:两|2)个工具/,
    /工具.*?(?:只有|有以下|仅有).*?(?:两|2)个/,
    /只能用.*?read_file/i,
    /无法调用.*?工具/,
    /(?:仅限于|仅用于).*?(?:查阅|浏览).*?(?:文档|docs)/,
    // ── 中文: 工具可用性声明 (2026-03 新增) ──
    /只有.*?读取.*?Cursor.*?工具/,
    /只有.*?读取.*?文档的工具/,
    /无法访问.*?本地文件/,
    /无法.*?执行命令/,
    /需要在.*?Claude\s*Code/i,
    /需要.*?CLI.*?环境/i,
    /当前环境.*?只有.*?工具/,
    /只有.*?read_file.*?read_dir/i,
    /只有.*?read_dir.*?read_file/i,

    // ── 中文: Cursor 中文界面拒绝措辞 (2026-03 批次) ──
    /只能回答.*(?:Cursor|编辑器).*(?:相关|有关)/,
    /专[注门].*(?:回答|帮助|解答).*(?:Cursor|编辑器)/,
    /有什么.*(?:Cursor|编辑器).*(?:问题|可以)/,
    /无法提供.*(?:推荐|建议|帮助)/,
    /(?:功能使用|账户|故障排除|账号|订阅|套餐|计费).*(?:等|问题)/,
];

// ==================== 自定义拒绝规则 ====================
// 从 config.yaml 的 refusal_patterns 字段编译，追加到内置列表之后，支持热重载

let _customRefusalPatterns: RegExp[] = [];
let _lastRefusalPatternsKey = '';

function getCustomRefusalPatterns(): RegExp[] {
    const config = getConfig();
    const patterns = config.refusalPatterns;
    if (!patterns || patterns.length === 0) return _customRefusalPatterns = [];

    // 用 join key 做缓存判断，避免每次调用都重新编译
    const key = patterns.join('\0');
    if (key === _lastRefusalPatternsKey) return _customRefusalPatterns;

    _lastRefusalPatternsKey = key;
    _customRefusalPatterns = [];
    for (const p of patterns) {
        try {
            _customRefusalPatterns.push(new RegExp(p, 'i'));
        } catch {
            // 无效正则 → 退化为字面量匹配
            _customRefusalPatterns.push(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
            console.warn(`[Config] refusal_patterns: "${p}" 不是有效正则，已转换为字面量匹配`);
        }
    }
    console.log(`[Config] 加载了 ${_customRefusalPatterns.length} 条自定义拒绝规则`);
    return _customRefusalPatterns;
}

/**
 * 检查文本是否匹配拒绝模式（内置 + 自定义规则）
 */
export function isRefusal(text: string): boolean {
    if (REFUSAL_PATTERNS.some(p => p.test(text))) return true;
    const custom = getCustomRefusalPatterns();
    return custom.length > 0 && custom.some(p => p.test(text));
}

// ==================== 身份探针检测 ====================
// 用户消息匹配以下模式时判定为身份探针，直接返回 mock 回复

export const IDENTITY_PROBE_PATTERNS: RegExp[] = [
    // 精确短句
    /^\s*(who are you\??|你是谁[呀啊吗]?\??|what is your name\??|你叫什么\??|你叫什么名字\??|what are you\??|你是什么\??|Introduce yourself\??|自我介绍一下\??|hi\??|hello\??|hey\??|你好\??|在吗\??|哈喽\??)\s*$/i,
    // 问模型/身份类
    /(?:什么|哪个|啥)\s*模型/,
    /(?:真实|底层|实际|真正).{0,10}(?:模型|身份|名字)/,
    /模型\s*(?:id|名|名称|名字|是什么)/i,
    /(?:what|which)\s+model/i,
    /(?:real|actual|true|underlying)\s+(?:model|identity|name)/i,
    /your\s+(?:model|identity|real\s+name)/i,
    // 问平台/运行环境类
    /运行在\s*(?:哪|那|什么)/,
    /(?:哪个|什么)\s*平台/,
    /running\s+on\s+(?:what|which)/i,
    /what\s+platform/i,
    // 问系统提示词类
    /系统\s*提示词/,
    /system\s*prompt/i,
    // "你是谁"的变体
    /你\s*(?:到底|究竟|真的|真实)\s*是\s*谁/,
    /你\s*是[^。，,\.]{0,5}(?:AI|人工智能|助手|机器人|模型|Claude|GPT|Gemini)/i,
    // 注意：工具能力询问不在这里拦截，由拒绝检测+重试自然处理
];

// ==================== 工具能力询问检测 ====================
// 用户问"你有哪些工具"时，重试失败后返回专用回复

export const TOOL_CAPABILITY_PATTERNS: RegExp[] = [
    /你\s*(?:有|能用|可以用)\s*(?:哪些|什么|几个)\s*(?:工具|tools?|functions?)/i,
    /(?:what|which|list).*?tools?/i,
    /你\s*用\s*(?:什么|哪个|啥)\s*(?:mcp|工具)/i,
    /你\s*(?:能|可以)\s*(?:做|干)\s*(?:什么|哪些|啥)/,
    /(?:what|which).*?(?:capabilities|functions)/i,
    /能力|功能/,
];

// ==================== 固定回复模板 ====================

/** Claude 身份回复（身份探针拦截 / 拒绝后降级） */
export const CLAUDE_IDENTITY_RESPONSE = `I am Claude, made by Anthropic. I'm an AI assistant designed to be helpful, harmless, and honest. I can help you with a wide range of tasks including writing, analysis, coding, math, and more.

I don't have information about the specific model version or ID being used for this conversation, but I'm happy to help you with whatever you need!`;

/** 工具能力询问的模拟回复（当用户问"你有哪些工具"时） */
export const CLAUDE_TOOLS_RESPONSE = `作为 Claude，我的核心能力包括：

**内置能力：**
- 💻 **代码编写与调试** — 支持所有主流编程语言
- 📝 **文本写作与分析** — 文章、报告、翻译等
- 📊 **数据分析与数学推理** — 复杂计算和逻辑分析
- 🧠 **问题解答与知识查询** — 各类技术和非技术问题

**工具调用能力（MCP）：**
如果你的客户端配置了 MCP（Model Context Protocol）工具，我可以通过工具调用来执行更多操作，例如：
- 🔍 **网络搜索** — 实时查找信息
- 📁 **文件操作** — 读写文件、执行命令
- 🛠️ **自定义工具** — 取决于你配置的 MCP Server

具体可用的工具取决于你客户端的配置。你可以告诉我你想做什么，我会尽力帮助你！`;
