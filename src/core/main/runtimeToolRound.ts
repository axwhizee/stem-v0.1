// ============================================================
// core/main/runtimeToolRound.ts —— 工具轮执行（并行 + contextWait 收束）
// ============================================================

import type { ChatMessage, ToolCallEvent } from '../gateway'
import type { ToolContext, ToolError } from '../tools'
import { errorBrief, formatToolOutput } from '../tools'
import type { AgentID } from '../kernel'

export interface ToolRoundDeps {
  readonly tools: {
    execute: (
      invocation: { id: string; name: string; input: unknown },
      ctx: ToolContext,
    ) => Promise<{ text: string; metadata?: Readonly<Record<string, unknown>> }>
  }
  readonly toolOutputLimit?: number
}

export interface ToolRoundResult {
  /** 可回填会话的 tool 消息（contextWait 调用不出现）。 */
  readonly messages: readonly ChatMessage[]
  /** 是否命中挂起（instantiate.wait / agent_pause）——轮循环应收束。 */
  readonly waiting: boolean
}

/**
 * 并行执行本轮 tool_calls；contextWait 命中则该调用不回填（等 deposit 正规填充）。
 * 领域错误（带 kind）原样进会话；非结构化异常收成 execution_failed。
 */
export async function executeToolRound(
  deps: ToolRoundDeps,
  agentId: AgentID,
  toolCalls: readonly ToolCallEvent[],
  ctx: ToolContext,
): Promise<ToolRoundResult> {
  let waiting = false
  const results = await Promise.all(
    toolCalls.map(async (call): Promise<ChatMessage | null> => {
      try {
        const result = await deps.tools.execute({ id: call.id, name: call.name, input: call.input }, ctx)
        if (result.metadata?.contextWait === true) {
          waiting = true
          return null
        }
        return {
          role: 'tool',
          content: formatToolOutput(result, { outputLimit: deps.toolOutputLimit }),
          toolCallId: call.id,
        }
      } catch (cause) {
        const error: ToolError =
          cause !== null && typeof cause === 'object' && 'kind' in cause && typeof (cause as { kind: unknown }).kind === 'string'
            ? (cause as ToolError)
            : { kind: 'execution_failed', tool: call.name, message: errorBrief(cause).message }
        return {
          role: 'tool',
          content: formatToolOutput(error, { outputLimit: deps.toolOutputLimit }),
          toolCallId: call.id,
        }
      }
    }),
  )
  return { messages: results.filter((r): r is ChatMessage => r !== null), waiting }
}
