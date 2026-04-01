import {
  isBetaTracingEnabled,
  type LLMRequestNewContext,
} from './betaSessionTracing.js'

export { isBetaTracingEnabled, type LLMRequestNewContext }

export interface Span {
  setAttribute(name: string, value: string | number | boolean): void
  setAttributes(attributes: Record<string, string | number | boolean>): void
  addEvent(
    name: string,
    attributes?: Record<string, string | number | boolean>,
  ): void
  end(): void
  recordException(error: unknown): void
}

type SpanMetadata = Record<string, string | number | boolean>

function createNoopSpan(): Span {
  return {
    setAttribute() {},
    setAttributes() {},
    addEvent() {},
    end() {},
    recordException() {},
  }
}

let currentInteractionSpan: Span | null = null
let currentToolSpan: Span | null = null

export function isEnhancedTelemetryEnabled(): boolean {
  return false
}

export function startInteractionSpan(_userPrompt: string): Span {
  const span = createNoopSpan()
  currentInteractionSpan = span
  return span
}

export function endInteractionSpan(): void {
  currentInteractionSpan = null
}

export function startLLMRequestSpan(
  _model: string,
  _newContext?: LLMRequestNewContext,
  _messagesForAPI?: unknown[],
  _fastMode?: boolean,
): Span {
  return createNoopSpan()
}

export function endLLMRequestSpan(
  _span?: Span,
  _metadata?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    success?: boolean
    statusCode?: number
    error?: string
    attempt?: number
    modelResponse?: string
    modelOutput?: string
    thinkingOutput?: string
    hasToolCall?: boolean
    ttftMs?: number
    requestSetupMs?: number
    attemptStartTimes?: number[]
  },
): void {}

export function startToolSpan(
  _toolName: string,
  _toolAttributes?: SpanMetadata,
  _toolInput?: string,
): Span {
  const span = createNoopSpan()
  currentToolSpan = span
  return span
}

export function startToolBlockedOnUserSpan(): Span {
  return createNoopSpan()
}

export function endToolBlockedOnUserSpan(
  _decision?: string,
  _source?: string,
): void {}

export function startToolExecutionSpan(): Span {
  return createNoopSpan()
}

export function endToolExecutionSpan(_metadata?: {
  success?: boolean
  error?: string
}): void {}

export function endToolSpan(
  _toolResult?: string,
  _resultTokens?: number,
): void {
  currentToolSpan = null
}

export function addToolContentEvent(
  _eventName: string,
  _attributes: SpanMetadata,
): void {}

export function getCurrentSpan(): Span | null {
  return currentToolSpan ?? currentInteractionSpan
}

export async function executeInSpan<T>(
  _spanName: string,
  fn: (span: Span) => Promise<T>,
  _attributes?: SpanMetadata,
): Promise<T> {
  return fn(createNoopSpan())
}

export function startHookSpan(
  _hookEvent: string,
  _hookName: string,
  _numHooks: number,
  _hookDefinitions: string,
): Span {
  return createNoopSpan()
}

export function endHookSpan(
  _span: Span,
  _metadata?: {
    numSuccess?: number
    numBlocking?: number
    numNonBlockingError?: number
    numCancelled?: number
  },
): void {}
