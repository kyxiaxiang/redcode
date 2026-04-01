/**
 * log-viewer.ts - 全链路日志 Web UI v4
 * 
 * 静态文件分离版：HTML/CSS/JS 放在 public/ 目录，此文件只包含 API 路由和文件服务
 */

import type { Request, Response } from 'express';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getAllLogs, getRequestSummaries, getStats, getVueStats, getRequestPayload, subscribeToLogs, subscribeToSummaries, clearAllLogs, getRequestSummariesPage } from './logger.js';

// ==================== 静态文件路径 ====================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const publicDir = join(__dirname, '..', 'public');

function readPublicFile(filename: string): string {
    return readFileSync(join(publicDir, filename), 'utf-8');
}

// ==================== API 路由 ====================

export function apiGetLogs(req: Request, res: Response): void {
    const { requestId, level, source, limit, since } = req.query;
    res.json(getAllLogs({
        requestId: requestId as string, level: level as any, source: source as any,
        limit: limit ? parseInt(limit as string) : 200,
        since: since ? parseInt(since as string) : undefined,
    }));
}

export function apiGetRequests(req: Request, res: Response): void {
    res.json(getRequestSummaries(req.query.limit ? parseInt(req.query.limit as string) : 50));
}

export function apiGetStats(req: Request, res: Response): void {
    res.json(getStats());
}

export function apiGetVueStats(req: Request, res: Response): void {
    const since = req.query.since ? parseInt(req.query.since as string) : undefined;
    res.json(getVueStats(since));
}

/** GET /api/payload/:requestId - 获取请求的完整参数和响应 */
export function apiGetPayload(req: Request, res: Response): void {
    const payload = getRequestPayload(req.params.requestId as string);
    if (!payload) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(payload);
}

/** POST /api/logs/clear - 清空所有日志 */
export function apiClearLogs(_req: Request, res: Response): void {
    const result = clearAllLogs();
    res.json({ success: true, ...result });
}

/** GET /api/requests/more?limit=50&before=<ts>&status=error&keyword=foo&since=<ts> - 游标分页 + 后端过滤（仅 Vue UI 使用） */
export function apiGetRequestsMore(req: Request, res: Response): void {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
    const before = req.query.before ? parseInt(req.query.before as string) : undefined;
    const since = req.query.since ? parseInt(req.query.since as string) : undefined;
    const status = (req.query.status as string) || undefined;
    const keyword = (req.query.keyword as string) || undefined;
    res.json(getRequestSummariesPage({ limit, before, since, status, keyword }));
}

export function apiLogsStream(req: Request, res: Response): void {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    const sse = (event: string, data: string) => 'event: ' + event + '\ndata: ' + data + '\n\n';
    try { res.write(sse('stats', JSON.stringify(getStats()))); } catch { /**/ }
    const unsubLog = subscribeToLogs(e => { try { res.write(sse('log', JSON.stringify(e))); } catch { /**/ } });
    const unsubSummary = subscribeToSummaries(s => {
        try { res.write(sse('summary', JSON.stringify(s))); res.write(sse('stats', JSON.stringify(getStats()))); } catch { /**/ }
    });
    const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch { /**/ } }, 15000);
    req.on('close', () => { unsubLog(); unsubSummary(); clearInterval(hb); });
}

// ==================== 页面服务 ====================

export function serveLogViewer(_req: Request, res: Response): void {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(readPublicFile('logs.html'));
}

export function serveLogViewerLogin(_req: Request, res: Response): void {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(readPublicFile('login.html'));
}

export function serveVueApp(_req: Request, res: Response): void {
    res.sendFile(join(publicDir, 'vue', 'index.html'));
}

/** 静态文件路由 - CSS/JS */
export function servePublicFile(req: Request, res: Response): void {
    const file = req.params[0]; // e.g. "logs.css" or "logs.js"
    const ext = file.split('.').pop();
    const mimeTypes: Record<string, string> = {
        'css': 'text/css',
        'js': 'application/javascript',
        'html': 'text/html',
    };
    try {
        const content = readPublicFile(file);
        res.setHeader('Content-Type', (mimeTypes[ext || ''] || 'text/plain') + '; charset=utf-8');
        res.send(content);
    } catch {
        res.status(404).send('Not found');
    }
}
