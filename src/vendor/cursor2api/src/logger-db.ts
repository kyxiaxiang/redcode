// Stubbed out logger-db.ts to remove better-sqlite3 dependency

export function initDb(dbPath: string) {}
export function closeDb() {}
export function isDbInitialized() { return false; }
export function dbInsertRequest(summary: any, payload: any) {}
export function dbGetPayload(requestId: string): any { return undefined; }
export function dbGetSummaries(opts?: any): any[] { return []; }
export function dbCountSummaries(opts?: any): number { return 0; }
export function dbGetSummaryCount(): number { return 0; }
export function dbGetStatusCounts(since?: number): Record<string, number> { return {}; }
export function dbGetSummariesSince(timestamp: number): any[] { return []; }
export function dbClear(): { cleared: number } { return { cleared: 0 }; }
export function dbGetStats(since?: number): any { return {}; }
