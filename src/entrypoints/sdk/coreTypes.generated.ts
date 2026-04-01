export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'

export type ExitReason =
  | 'clear'
  | 'resume'
  | 'logout'
  | 'prompt_input_exit'
  | 'other'
  | 'bypass_permissions_disabled'

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'StopFailure'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PostCompact'
  | 'PermissionRequest'
  | 'PermissionDenied'
  | 'Setup'
  | 'TeammateIdle'
  | 'TaskCreated'
  | 'TaskCompleted'
  | 'Elicitation'
  | 'ElicitationResult'
  | 'ConfigChange'
  | 'WorktreeCreate'
  | 'WorktreeRemove'
  | 'InstructionsLoaded'
  | 'CwdChanged'
  | 'FileChanged'

export type ModelUsage = {
  costUSD?: number
  inputTokens?: number
  outputTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  [key: string]: number | undefined
}

export type SDKStatus = 'compacting' | string | null

export type SDKBaseMessage = {
  type: string
  subtype?: string
  uuid?: string
  session_id?: string
  [key: string]: unknown
}

export type SDKAssistantMessage = SDKBaseMessage & {
  type: 'assistant'
  message?: { content?: unknown[] }
}

export type SDKAssistantMessageError = SDKBaseMessage & {
  type: 'assistant_error'
  message?: string
}

export type SDKPartialAssistantMessage = SDKBaseMessage & {
  type: 'assistant_partial'
  delta?: string
}

export type SDKResultMessage = SDKBaseMessage & {
  type: 'result'
  is_error?: boolean
  result?: string
  duration_ms?: number
  total_cost_usd?: number
}

export type SDKStatusMessage = SDKBaseMessage & {
  type: 'status'
  status: SDKStatus
}

export type SDKSystemMessage = SDKBaseMessage & {
  type: 'system'
  content?: string
}

export type SDKCompactBoundaryMessage = SDKSystemMessage & {
  subtype: 'compact_boundary' | 'microcompact_boundary'
}

export type SDKToolProgressMessage = SDKBaseMessage & {
  type: 'tool_progress'
  data?: Record<string, unknown>
}

export type SDKPermissionDenial = SDKBaseMessage & {
  type: 'permission_denial'
  mode?: PermissionMode
  toolName?: string
}

export type SDKRateLimitInfo = {
  remaining?: number
  resetAt?: string
}

export type SDKUserMessage = SDKBaseMessage & {
  type: 'user'
  message?: { content?: unknown }
}

export type SDKUserMessageReplay = SDKUserMessage & {
  isReplay?: boolean
}

export type SDKSessionInfo = {
  sessionId: string
  summary?: string
  cwd?: string
  createdAt?: string
  updatedAt?: string
}

export type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string }
  | { behavior: 'ask'; updatedInput?: Record<string, unknown>; message?: string }

export type HookInput = {
  session_id?: string
  event?: HookEvent
  [key: string]: unknown
}

export type HookJSONOutput = {
  continue?: boolean
  stopReason?: string
  message?: string
  decision?: 'allow' | 'deny' | 'ask'
  [key: string]: unknown
}

export type SyncHookJSONOutput = HookJSONOutput

export type AsyncHookJSONOutput = HookJSONOutput & {
  waitMs?: number
}

export type SDKMessage =
  | SDKAssistantMessage
  | SDKAssistantMessageError
  | SDKCompactBoundaryMessage
  | SDKPartialAssistantMessage
  | SDKPermissionDenial
  | SDKResultMessage
  | SDKStatusMessage
  | SDKSystemMessage
  | SDKToolProgressMessage
  | SDKUserMessage
  | SDKUserMessageReplay
