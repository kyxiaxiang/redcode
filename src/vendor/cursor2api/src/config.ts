import { readFileSync, existsSync, watch, type FSWatcher } from 'fs';
import { parse as parseYaml } from 'yaml';
import type { AppConfig } from './types.js';

let config: AppConfig;
let watcher: FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// 配置变更回调
type ConfigReloadCallback = (newConfig: AppConfig, changes: string[]) => void;
const reloadCallbacks: ConfigReloadCallback[] = [];

/**
 * 注册配置热重载回调
 */
export function onConfigReload(cb: ConfigReloadCallback): void {
    reloadCallbacks.push(cb);
}

/**
 * 从 config.yaml 解析配置（纯解析，不含环境变量覆盖）
 */
function parseYamlConfig(defaults: AppConfig): { config: AppConfig; raw: Record<string, unknown> | null } {
    const result = { ...defaults, fingerprint: { ...defaults.fingerprint } };
    let raw: Record<string, unknown> | null = null;

    if (!existsSync('config.yaml')) return { config: result, raw };

    try {
        const content = readFileSync('config.yaml', 'utf-8');
        const yaml = parseYaml(content);
        raw = yaml;

        if (yaml.port) result.port = yaml.port;
        if (yaml.timeout) result.timeout = yaml.timeout;
        if (yaml.proxy) result.proxy = yaml.proxy;
        if (yaml.cursor_model) result.cursorModel = yaml.cursor_model;
        if (typeof yaml.max_auto_continue === 'number') result.maxAutoContinue = yaml.max_auto_continue;
        if (typeof yaml.max_history_messages === 'number') result.maxHistoryMessages = yaml.max_history_messages;
        if (typeof yaml.max_history_tokens === 'number') result.maxHistoryTokens = yaml.max_history_tokens;
        if (yaml.fingerprint) {
            if (yaml.fingerprint.user_agent) result.fingerprint.userAgent = yaml.fingerprint.user_agent;
        }
        if (yaml.vision) {
            result.vision = {
                enabled: yaml.vision.enabled !== false,
                mode: yaml.vision.mode || 'ocr',
                baseUrl: yaml.vision.base_url || 'https://api.openai.com/v1/chat/completions',
                apiKey: yaml.vision.api_key || '',
                model: yaml.vision.model || 'gpt-4o-mini',
                proxy: yaml.vision.proxy || undefined,
            };
        }
        // ★ API 鉴权 token
        if (yaml.auth_tokens) {
            result.authTokens = Array.isArray(yaml.auth_tokens)
                ? yaml.auth_tokens.map(String)
                : String(yaml.auth_tokens).split(',').map((s: string) => s.trim()).filter(Boolean);
        }
        // ★ 历史压缩配置
        if (yaml.compression !== undefined) {
            const c = yaml.compression;
            result.compression = {
                enabled: c.enabled !== false, // 默认启用
                level: [1, 2, 3].includes(c.level) ? c.level : 1,
                keepRecent: typeof c.keep_recent === 'number' ? c.keep_recent : 10,
                earlyMsgMaxChars: typeof c.early_msg_max_chars === 'number' ? c.early_msg_max_chars : 4000,
            };
        }
        // ★ Thinking 开关（最高优先级）
        if (yaml.thinking !== undefined) {
            result.thinking = {
                enabled: yaml.thinking.enabled !== false, // 默认启用
            };
        }
        // ★ 日志文件持久化
        if (yaml.logging !== undefined) {
            const persistModes = ['compact', 'full', 'summary'];
            result.logging = {
                file_enabled: yaml.logging.file_enabled === true, // 默认关闭
                dir: yaml.logging.dir || './logs',
                max_days: typeof yaml.logging.max_days === 'number' ? yaml.logging.max_days : 7,
                persist_mode: persistModes.includes(yaml.logging.persist_mode) ? yaml.logging.persist_mode : 'summary',
                db_enabled: yaml.logging.db_enabled === true,
                db_path: yaml.logging.db_path || './logs/cursor2api.db',
            };
        }
        // ★ 工具处理配置
        if (yaml.tools !== undefined) {
            const t = yaml.tools;
            const validModes = ['compact', 'full', 'names_only'];
            result.tools = {
                schemaMode: validModes.includes(t.schema_mode) ? t.schema_mode : 'full',
                descriptionMaxLength: typeof t.description_max_length === 'number' ? t.description_max_length : 0,
                includeOnly: Array.isArray(t.include_only) ? t.include_only.map(String) : undefined,
                exclude: Array.isArray(t.exclude) ? t.exclude.map(String) : undefined,
                passthrough: t.passthrough === true,
                disabled: t.disabled === true,
                adaptiveBudget: t.adaptive_budget === true,    // 默认关闭
                smartTruncation: t.smart_truncation === true,   // 默认关闭
            };
        }
        // ★ 响应内容清洗开关（默认关闭）
        if (yaml.sanitize_response !== undefined) {
            result.sanitizeEnabled = yaml.sanitize_response === true;
        }
        // ★ 自定义拒绝检测规则
        if (Array.isArray(yaml.refusal_patterns)) {
            result.refusalPatterns = yaml.refusal_patterns.map(String).filter(Boolean);
        }
        // ★ 上下文压力膨胀系数
        if (typeof yaml.context_pressure === 'number') {
            result.contextPressure = yaml.context_pressure;
        }
    } catch (e) {
        console.warn('[Config] 读取 config.yaml 失败:', e);
    }

    return { config: result, raw };
}

/**
 * 应用环境变量覆盖（环境变量优先级最高，不受热重载影响）
 */
function applyEnvOverrides(cfg: AppConfig): void {
    if (process.env.PORT) cfg.port = parseInt(process.env.PORT);
    if (process.env.TIMEOUT) cfg.timeout = parseInt(process.env.TIMEOUT);
    if (process.env.PROXY) cfg.proxy = process.env.PROXY;
    if (process.env.CURSOR_MODEL) cfg.cursorModel = process.env.CURSOR_MODEL;
    if (process.env.MAX_AUTO_CONTINUE !== undefined) cfg.maxAutoContinue = parseInt(process.env.MAX_AUTO_CONTINUE);
    if (process.env.MAX_HISTORY_MESSAGES !== undefined) cfg.maxHistoryMessages = parseInt(process.env.MAX_HISTORY_MESSAGES);
    if (process.env.MAX_HISTORY_TOKENS !== undefined) cfg.maxHistoryTokens = parseInt(process.env.MAX_HISTORY_TOKENS);
    if (process.env.AUTH_TOKEN) {
        cfg.authTokens = process.env.AUTH_TOKEN.split(',').map(s => s.trim()).filter(Boolean);
    }
    // 压缩环境变量覆盖
    if (process.env.COMPRESSION_ENABLED !== undefined) {
        if (!cfg.compression) cfg.compression = { enabled: false, level: 1, keepRecent: 10, earlyMsgMaxChars: 4000 };
        cfg.compression.enabled = process.env.COMPRESSION_ENABLED !== 'false' && process.env.COMPRESSION_ENABLED !== '0';
    }
    if (process.env.COMPRESSION_LEVEL) {
        if (!cfg.compression) cfg.compression = { enabled: false, level: 1, keepRecent: 10, earlyMsgMaxChars: 4000 };
        const lvl = parseInt(process.env.COMPRESSION_LEVEL);
        if (lvl >= 1 && lvl <= 3) cfg.compression.level = lvl as 1 | 2 | 3;
    }
    // Thinking 环境变量覆盖（最高优先级）
    if (process.env.THINKING_ENABLED !== undefined) {
        cfg.thinking = {
            enabled: process.env.THINKING_ENABLED !== 'false' && process.env.THINKING_ENABLED !== '0',
        };
    }
    // Logging 环境变量覆盖
    if (process.env.LOG_FILE_ENABLED !== undefined) {
        if (!cfg.logging) cfg.logging = { file_enabled: false, dir: './logs', max_days: 7, persist_mode: 'summary', db_enabled: false, db_path: './logs/cursor2api.db' };
        cfg.logging.file_enabled = process.env.LOG_FILE_ENABLED === 'true' || process.env.LOG_FILE_ENABLED === '1';
    }
    if (process.env.LOG_DIR) {
        if (!cfg.logging) cfg.logging = { file_enabled: false, dir: './logs', max_days: 7, persist_mode: 'summary', db_enabled: false, db_path: './logs/cursor2api.db' };
        cfg.logging.dir = process.env.LOG_DIR;
    }
    if (process.env.LOG_PERSIST_MODE) {
        if (!cfg.logging) cfg.logging = { file_enabled: false, dir: './logs', max_days: 7, persist_mode: 'summary', db_enabled: false, db_path: './logs/cursor2api.db' };
        cfg.logging.persist_mode = process.env.LOG_PERSIST_MODE === 'full'
            ? 'full'
            : process.env.LOG_PERSIST_MODE === 'summary'
                ? 'summary'
                : 'compact';
    }
    if (process.env.LOG_DB_ENABLED !== undefined) {
        if (!cfg.logging) cfg.logging = { file_enabled: false, dir: './logs', max_days: 7, persist_mode: 'summary', db_enabled: false, db_path: './logs/cursor2api.db' };
        cfg.logging.db_enabled = process.env.LOG_DB_ENABLED === 'true' || process.env.LOG_DB_ENABLED === '1';
    }
    if (process.env.LOG_DB_PATH) {
        if (!cfg.logging) cfg.logging = { file_enabled: false, dir: './logs', max_days: 7, persist_mode: 'summary', db_enabled: false, db_path: './logs/cursor2api.db' };
        cfg.logging.db_path = process.env.LOG_DB_PATH;
    }
    // 工具透传模式环境变量覆盖
    if (process.env.TOOLS_PASSTHROUGH !== undefined) {
        if (!cfg.tools) cfg.tools = { schemaMode: 'full', descriptionMaxLength: 0 };
        cfg.tools.passthrough = process.env.TOOLS_PASSTHROUGH === 'true' || process.env.TOOLS_PASSTHROUGH === '1';
    }
    // 工具禁用模式环境变量覆盖
    if (process.env.TOOLS_DISABLED !== undefined) {
        if (!cfg.tools) cfg.tools = { schemaMode: 'full', descriptionMaxLength: 0 };
        cfg.tools.disabled = process.env.TOOLS_DISABLED === 'true' || process.env.TOOLS_DISABLED === '1';
    }
    // 自适应历史预算环境变量覆盖
    if (process.env.TOOLS_ADAPTIVE_BUDGET !== undefined) {
        if (!cfg.tools) cfg.tools = { schemaMode: 'full', descriptionMaxLength: 0 };
        cfg.tools.adaptiveBudget = process.env.TOOLS_ADAPTIVE_BUDGET !== 'false' && process.env.TOOLS_ADAPTIVE_BUDGET !== '0';
    }
    // 智能截断环境变量覆盖
    if (process.env.TOOLS_SMART_TRUNCATION !== undefined) {
        if (!cfg.tools) cfg.tools = { schemaMode: 'full', descriptionMaxLength: 0 };
        cfg.tools.smartTruncation = process.env.TOOLS_SMART_TRUNCATION !== 'false' && process.env.TOOLS_SMART_TRUNCATION !== '0';
    }

    // 响应内容清洗环境变量覆盖
    if (process.env.SANITIZE_RESPONSE !== undefined) {
        cfg.sanitizeEnabled = process.env.SANITIZE_RESPONSE === 'true' || process.env.SANITIZE_RESPONSE === '1';
    }
    // 上下文压力膨胀系数环境变量覆盖
    if (process.env.CONTEXT_PRESSURE !== undefined) {
        cfg.contextPressure = parseFloat(process.env.CONTEXT_PRESSURE);
    }

    // 从 base64 FP 环境变量解析指纹
    if (process.env.FP) {
        try {
            const fp = JSON.parse(Buffer.from(process.env.FP, 'base64').toString());
            if (fp.userAgent) cfg.fingerprint.userAgent = fp.userAgent;
        } catch (e) {
            console.warn('[Config] 解析 FP 环境变量失败:', e);
        }
    }
}

/**
 * 构建默认配置
 */
function defaultConfig(): AppConfig {
    return {
        port: 3010,
        timeout: 120,
        cursorModel: 'anthropic/claude-sonnet-4.6',
        maxAutoContinue: 0,
        maxHistoryMessages: -1,
        maxHistoryTokens: 150000,
        sanitizeEnabled: false,  // 默认关闭响应内容清洗
        fingerprint: {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        },
    };
}

/**
 * 检测配置变更并返回变更描述列表
 */
function detectChanges(oldCfg: AppConfig, newCfg: AppConfig): string[] {
    const changes: string[] = [];

    if (oldCfg.port !== newCfg.port) changes.push(`port: ${oldCfg.port} → ${newCfg.port}`);
    if (oldCfg.timeout !== newCfg.timeout) changes.push(`timeout: ${oldCfg.timeout} → ${newCfg.timeout}`);
    if (oldCfg.proxy !== newCfg.proxy) changes.push(`proxy: ${oldCfg.proxy || '(none)'} → ${newCfg.proxy || '(none)'}`);
    if (oldCfg.cursorModel !== newCfg.cursorModel) changes.push(`cursor_model: ${oldCfg.cursorModel} → ${newCfg.cursorModel}`);
    if (oldCfg.maxAutoContinue !== newCfg.maxAutoContinue) changes.push(`max_auto_continue: ${oldCfg.maxAutoContinue} → ${newCfg.maxAutoContinue}`);
    if (oldCfg.maxHistoryMessages !== newCfg.maxHistoryMessages) changes.push(`max_history_messages: ${oldCfg.maxHistoryMessages} → ${newCfg.maxHistoryMessages}`);
    if (oldCfg.maxHistoryTokens !== newCfg.maxHistoryTokens) changes.push(`max_history_tokens: ${oldCfg.maxHistoryTokens} → ${newCfg.maxHistoryTokens}`);

    // auth_tokens
    const oldTokens = (oldCfg.authTokens || []).join(',');
    const newTokens = (newCfg.authTokens || []).join(',');
    if (oldTokens !== newTokens) changes.push(`auth_tokens: ${oldCfg.authTokens?.length || 0} → ${newCfg.authTokens?.length || 0} token(s)`);

    // thinking
    if (JSON.stringify(oldCfg.thinking) !== JSON.stringify(newCfg.thinking)) changes.push(`thinking: ${JSON.stringify(oldCfg.thinking)} → ${JSON.stringify(newCfg.thinking)}`);

    // vision
    if (JSON.stringify(oldCfg.vision) !== JSON.stringify(newCfg.vision)) changes.push('vision: (changed)');

    // compression
    if (JSON.stringify(oldCfg.compression) !== JSON.stringify(newCfg.compression)) changes.push('compression: (changed)');

    // logging
    if (JSON.stringify(oldCfg.logging) !== JSON.stringify(newCfg.logging)) changes.push('logging: (changed)');

    // tools
    if (JSON.stringify(oldCfg.tools) !== JSON.stringify(newCfg.tools)) changes.push('tools: (changed)');

    // refusalPatterns
    // sanitize_response
    if (oldCfg.sanitizeEnabled !== newCfg.sanitizeEnabled) changes.push(`sanitize_response: ${oldCfg.sanitizeEnabled} → ${newCfg.sanitizeEnabled}`);

    if (JSON.stringify(oldCfg.refusalPatterns) !== JSON.stringify(newCfg.refusalPatterns)) changes.push(`refusal_patterns: ${oldCfg.refusalPatterns?.length || 0} → ${newCfg.refusalPatterns?.length || 0} rule(s)`);

    // fingerprint
    if (oldCfg.fingerprint.userAgent !== newCfg.fingerprint.userAgent) changes.push('fingerprint: (changed)');

    return changes;
}

/**
 * 获取当前配置（所有模块统一通过此函数获取最新配置）
 */
export function getConfig(): AppConfig {
    if (config) return config;

    // 首次加载
    const defaults = defaultConfig();
    const { config: parsed } = parseYamlConfig(defaults);
    applyEnvOverrides(parsed);
    config = parsed;
    return config;
}

/**
 * 初始化 config.yaml 文件监听，实现热重载
 *
 * 端口变更仅记录警告（需重启生效），其他字段下一次请求即生效。
 * 环境变量覆盖始终保持最高优先级，不受热重载影响。
 */
export function initConfigWatcher(): void {
    if (watcher) return; // 避免重复初始化
    if (!existsSync('config.yaml')) {
        console.log('[Config] config.yaml 不存在，跳过热重载监听');
        return;
    }

    const DEBOUNCE_MS = 500;

    watcher = watch('config.yaml', (eventType) => {
        if (eventType !== 'change') return;

        // 防抖：多次快速写入只触发一次重载
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            try {
                if (!existsSync('config.yaml')) {
                    console.warn('[Config] ⚠️  config.yaml 已被删除，保持当前配置');
                    return;
                }

                const oldConfig = config;
                const oldPort = oldConfig.port;

                // 重新解析 YAML + 环境变量覆盖
                const defaults = defaultConfig();
                const { config: newConfig } = parseYamlConfig(defaults);
                applyEnvOverrides(newConfig);

                // 检测变更
                const changes = detectChanges(oldConfig, newConfig);
                if (changes.length === 0) return; // 无实质变更

                // ★ 端口变更特殊处理：仅警告，不生效
                if (newConfig.port !== oldPort) {
                    console.warn(`[Config] ⚠️  检测到 port 变更 (${oldPort} → ${newConfig.port})，端口变更需要重启服务才能生效`);
                    newConfig.port = oldPort; // 保持原端口
                }

                // 替换全局配置对象（下一次 getConfig() 调用即返回新配置）
                config = newConfig;

                console.log(`[Config] 🔄 config.yaml 已热重载，${changes.length} 项变更:`);
                changes.forEach(c => console.log(`  └─ ${c}`));

                // 触发回调
                for (const cb of reloadCallbacks) {
                    try {
                        cb(newConfig, changes);
                    } catch (e) {
                        console.warn('[Config] 热重载回调执行失败:', e);
                    }
                }
            } catch (e) {
                console.error('[Config] ❌ 热重载失败，保持当前配置:', e);
            }
        }, DEBOUNCE_MS);
    });

    // 异常处理：watcher 挂掉后尝试重建
    watcher.on('error', (err) => {
        console.error('[Config] ❌ 文件监听异常:', err);
        watcher = null;
        // 2 秒后尝试重新建立监听
        setTimeout(() => {
            console.log('[Config] 🔄 尝试重新建立 config.yaml 监听...');
            initConfigWatcher();
        }, 2000);
    });

    console.log('[Config] 👁️  正在监听 config.yaml 变更（热重载已启用）');
}

/**
 * 停止文件监听（用于优雅关闭）
 */
export function stopConfigWatcher(): void {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    if (watcher) {
        watcher.close();
        watcher = null;
    }
}
