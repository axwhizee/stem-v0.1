// ============================================================
// core/main/runtimeHalt.ts —— 中断/错误收尾（消息闭合）
// ============================================================

import { isAbortError, isGatewayError } from '../gateway'
import { errorBrief } from '../tools'
import type { AgentID, AgentStatus } from '../kernel'

/** 中断后收尾标记（消息闭合：避免出现"assistant 后直接接 user"的非法消息序列）。 */
export const INTERRUPTED_MARKER = '<interrupted>'

export interface HaltDeps {
  readonly appendHistory: (agentId: AgentID, message: { role: 'assistant'; content: string }) => Promise<void>
  readonly onLog?: (event: {
    type: 'kernel.instance.interrupted'
    at: number
    agentId: string
    aborted: boolean
    errorKind?: string
    message: string
  }) => void
  readonly setStatus: (instance: { readonly id: AgentID; status: AgentStatus }, to: AgentStatus) => Promise<void>
}

/**
 * 中断/错误收尾：保证消息闭合（消息完整性）。
 * - 主动中断：部分 assistant 补 `<interrupted>` 入库；
 * - 网关/工具错误：部分 assistant 原样入库 + 错误日志；
 * - 状态 → interrupted（实例存活、可恢复）。
 */
export async function haltTurn(
  deps: HaltDeps,
  instance: { readonly id: AgentID; status: AgentStatus },
  cause: unknown,
  partial: { partialText: string; partialReasoning: string },
): Promise<void> {
  const aborted = isAbortError(cause)
  const gatewayError = isGatewayError(cause)
  const brief = errorBrief(cause)
  const message =
    aborted && partial.partialText !== ''
      ? `${partial.partialText}\n${INTERRUPTED_MARKER}`
      : partial.partialText

  if (message !== '') {
    await deps.appendHistory(instance.id, { role: 'assistant', content: message })
  }

  deps.onLog?.({
    type: 'kernel.instance.interrupted',
    at: Date.now(),
    agentId: instance.id,
    aborted,
    errorKind: gatewayError ? cause.kind : brief.kind,
    message: gatewayError ? cause.message : aborted ? 'aborted' : brief.message,
  })

  await deps.setStatus(instance, 'interrupted')
}
