/**
 * Telemetry instrumentation is disabled in the OSS build.
 */

export function bootstrapTelemetry(): void {}

export function parseExporterTypes(value: string | undefined): string[] {
  return (value || '')
    .trim()
    .split(',')
    .filter(Boolean)
    .map(token => token.trim())
    .filter(token => token !== 'none')
}

export function isTelemetryEnabled(): boolean {
  return false
}

export async function initializeTelemetry(): Promise<null> {
  return null
}

export async function flushTelemetry(): Promise<void> {}
