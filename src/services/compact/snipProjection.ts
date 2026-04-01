type BoundaryLikeMessage = {
  type?: string
  subtype?: string
}

export function isSnipBoundaryMessage(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as BoundaryLikeMessage).subtype === 'snip_boundary'
  )
}

export function projectSnippedView<T>(messages: T[]): T[] {
  return messages
}
