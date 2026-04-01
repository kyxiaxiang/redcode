/**
 * Analytics service - public API for event logging
 *
 * The open build intentionally ships without product telemetry. We keep this
 * module as a compatibility boundary so existing call sites can remain
 * unchanged while all analytics become inert.
 */

export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = never
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED = never

export function stripProtoFields<V>(
  metadata: Record<string, V>,
): Record<string, V> {
  return metadata
}

type LogEventMetadata = { [key: string]: boolean | number | undefined }

export type AnalyticsSink = {
  logEvent: (eventName: string, metadata: LogEventMetadata) => void
  logEventAsync: (
    eventName: string,
    metadata: LogEventMetadata,
  ) => Promise<void>
}

export function attachAnalyticsSink(_newSink: AnalyticsSink): void {}

export function logEvent(
  _eventName: string,
  _metadata: LogEventMetadata,
): void {}

export async function logEventAsync(
  _eventName: string,
  _metadata: LogEventMetadata,
): Promise<void> {}

export function _resetForTesting(): void {}
