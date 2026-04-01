/**
 * Datadog logging is intentionally disabled in the OSS build.
 */

export const initializeDatadog = async (): Promise<boolean> => false

export async function shutdownDatadog(): Promise<void> {}

export async function trackDatadogEvent(
  _eventName: string,
  _properties: { [key: string]: boolean | number | undefined },
): Promise<void> {}
