import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import type { ZodTypeAny } from 'zod/v4'

export type EffortLevel = 'low' | 'medium' | 'high' | 'max'

export type AnyZodRawShape = Record<string, ZodTypeAny>

export type InferShape<Schema extends AnyZodRawShape> = {
  [K in keyof Schema]?: unknown
}

export type SdkMcpToolDefinition<Schema extends AnyZodRawShape> = {
  name: string
  description: string
  inputSchema: Schema
  handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>
  annotations?: ToolAnnotations
  searchHint?: string
  alwaysLoad?: boolean
}

export type McpSdkServerConfigWithInstance = Record<string, unknown>

export type Options = Record<string, unknown>
export type InternalOptions = Options

export type SDKSessionOptions = Options & {
  model?: string
}

export type Query = AsyncIterable<unknown>
export type InternalQuery = AsyncIterable<unknown>

export type SessionMutationOptions = {
  dir?: string
}

export type ListSessionsOptions = SessionMutationOptions & {
  limit?: number
  offset?: number
}

export type GetSessionInfoOptions = SessionMutationOptions

export type GetSessionMessagesOptions = SessionMutationOptions & {
  limit?: number
  offset?: number
  includeSystemMessages?: boolean
}

export type ForkSessionOptions = SessionMutationOptions

export type ForkSessionResult = {
  sessionId: string
}

export type SDKSession = {
  id: string
}
