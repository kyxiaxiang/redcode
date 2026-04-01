type SnipLikeMessage = {
  type?: string
  subtype?: string
}

export const SNIP_NUDGE_TEXT =
  'Context-efficiency hints are unavailable in this reconstructed source snapshot.'

export function isSnipRuntimeEnabled(): boolean {
  return false
}

export function shouldNudgeForSnips(_messages: readonly unknown[]): boolean {
  return false
}

export function isSnipMarkerMessage(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as SnipLikeMessage).subtype === 'snip_marker'
  )
}

export function snipCompactIfNeeded<T>(
  messages: T[],
  _options?: { force?: boolean },
): {
  messages: T[]
  tokensFreed: number
  boundaryMessage?: T
  executed: boolean
} {
  return {
    messages,
    tokensFreed: 0,
    executed: false,
  }
}
