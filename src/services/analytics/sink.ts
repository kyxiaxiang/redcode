/**
 * Analytics sink implementation
 *
 * Telemetry sinks are disabled in this build. The exported functions remain so
 * startup code does not need to special-case the OSS variant.
 */

export function initializeAnalyticsGates(): void {}

export function initializeAnalyticsSink(): void {}
