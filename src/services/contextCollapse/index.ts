type ContextCollapseStats = {
  collapsedSpans: number
  collapsedMessages: number
  stagedSpans: number
  health: {
    totalErrors: number
    totalEmptySpawns: number
    totalSpawns: number
    emptySpawnWarningEmitted: boolean
    lastError: string | null
  }
}

const EMPTY_STATS: ContextCollapseStats = {
  collapsedSpans: 0,
  collapsedMessages: 0,
  stagedSpans: 0,
  health: {
    totalErrors: 0,
    totalEmptySpawns: 0,
    totalSpawns: 0,
    emptySpawnWarningEmitted: false,
    lastError: null,
  },
}

export function initContextCollapse(): void {}

export function resetContextCollapse(): void {}

export function isContextCollapseEnabled(): boolean {
  return false
}

export function getStats(): ContextCollapseStats {
  return EMPTY_STATS
}

export function subscribe(_callback: () => void): () => void {
  return () => {}
}

export async function applyCollapsesIfNeeded<T>(
  messages: T[],
  _toolUseContext: unknown,
  _querySource?: string,
): Promise<{ messages: T[] }> {
  return { messages }
}

export function recoverFromOverflow<T>(
  messages: T[],
  _querySource?: string,
): { messages: T[]; committed: number } {
  return {
    messages,
    committed: 0,
  }
}

export function isWithheldPromptTooLong(
  _message: unknown,
  _isPromptTooLongMessage: (message: unknown) => boolean,
  _querySource?: string,
): boolean {
  return false
}
