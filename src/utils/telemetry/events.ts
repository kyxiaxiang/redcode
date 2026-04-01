function isUserPromptLoggingEnabled(): boolean {
  return false
}

export function redactIfDisabled(content: string): string {
  return isUserPromptLoggingEnabled() ? content : '<REDACTED>'
}

export async function logOTelEvent(
  _eventName: string,
  _metadata: { [key: string]: string | undefined } = {},
): Promise<void> {}
