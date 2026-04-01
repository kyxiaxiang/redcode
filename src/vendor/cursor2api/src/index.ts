/**
 * Cursor2API Embedded Entrance
 */

import express from 'express';
import { getConfig } from './config.js';
import { handleMessages, listModels, countTokens } from './handler.js';
import { handleOpenAIChatCompletions, handleOpenAIResponses } from './openai-handler.js';

const app = express();

app.use(express.json({ limit: '50mb' }));

app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', '*');
    if (_req.method === 'OPTIONS') {
        res.sendStatus(200);
        return;
    }
    next();
});

app.use((req, res, next) => {
    if (req.method === 'GET' || req.path === '/health') return next();
    const config = getConfig();
    const tokens = config.authTokens;
    if (!tokens || tokens.length === 0) return next();
    
    const authHeader = req.headers['authorization'] || req.headers['x-api-key'];
    if (!authHeader) {
        res.status(401).json({ error: { message: 'Missing auth', type: 'auth_error' } });
        return;
    }
    const token = String(authHeader).replace(/^Bearer\s+/i, '').trim();
    if (!tokens.includes(token)) {
        console.error(`[Proxy] Token mismatch! Expected one of: ${JSON.stringify(tokens)}, got: "${token}"`);
        res.status(403).json({ error: { message: 'Invalid token', type: 'auth_error' } });
        return;
    }
    next();
});

app.post('/v1/messages', handleMessages);
app.post('/messages', handleMessages);
app.post('/v1/chat/completions', handleOpenAIChatCompletions);
app.post('/chat/completions', handleOpenAIChatCompletions);
app.post('/v1/responses', handleOpenAIResponses);
app.post('/responses', handleOpenAIResponses);
app.post('/v1/messages/count_tokens', countTokens);
app.post('/messages/count_tokens', countTokens);
app.get('/v1/models', listModels);
app.get('/health', (_req, res) => res.json({ status: 'ok', version: 'embedded' }));

export function startCursor2ApiProxy(port: number, token: string) {
    process.env.PORT = port.toString();
    process.env.AUTH_TOKEN = token;
    
    // Explicitly mutate internal config singleton because it caches early
    const cfg = getConfig();
    // Set to empty array to completely disable proxy auth checks
    cfg.authTokens = [];
    cfg.port = port;
    if (process.env.CURSOR_MODEL) {
        cfg.cursorModel = process.env.CURSOR_MODEL;
    }
    
    // Explicitly disable heavy logging modes to save CPU/Memory
    process.env.LOG_FILE_ENABLED = 'false';
    process.env.LOG_DB_ENABLED = 'false';
    process.env.TOOLS_SCHEMA_MODE = 'compact';
    process.env.THINKING_ENABLED = 'true'; // Enable thinking path globally for proxy

    return new Promise<void>((resolve) => {
        app.listen(port, '127.0.0.1', () => {
            resolve();
        });
    });
}
