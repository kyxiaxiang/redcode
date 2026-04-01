import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { VERIFY_PLAN_EXECUTION_TOOL_NAME } from './constants.js'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    verified: z.boolean(),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

type Output = z.infer<OutputSchema>

const UNAVAILABLE_MESSAGE =
  'Plan execution verification is unavailable in this reconstructed build.'

export const VerifyPlanExecutionTool = buildTool({
  name: VERIFY_PLAN_EXECUTION_TOOL_NAME,
  maxResultSizeChars: 4_096,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return false
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  async description() {
    return UNAVAILABLE_MESSAGE
  },
  async prompt() {
    return UNAVAILABLE_MESSAGE
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.message,
    }
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage() {
    return null
  },
  async call() {
    return {
      data: {
        verified: false,
        message: UNAVAILABLE_MESSAGE,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
