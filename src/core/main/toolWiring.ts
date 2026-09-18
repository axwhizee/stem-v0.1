// ============================================================
// core/main/toolWiring.ts —— internal 工具定义 + 工具记录 sink
//
//   1. `createInternalToolDefs`：经 `createInternalTools`（internal 唯一出入口）
//      产出系统工具 + （注入 ShellRunner 才装配的）bash 定义；
//      组合根 / 测试 harness 统一经 **drain** 入表（不再有旁路 register）。
//   2. `attachToolRecordSink`：工具执行三相位 → 事件流 tool 变体 + 仓库记录/历史行。
// ============================================================

import type { Kernel } from '../kernel'
import { createSystemToolHost } from '../kernel'
import type { BashToolSettings, ShellRunner, ToolCapability, ToolCapabilityRegistry } from '../tools'
import { formatToolOutput } from '../tools'
import { createInternalTools } from '../tools/internal'
import { forget } from '../logging'

export interface InternalToolWiringOptions {
  /** bash 端口（宿主注入 ShellRunner 才装配；core 零平台依赖）。 */
  readonly bash?: { readonly runner: ShellRunner; readonly settings?: BashToolSettings }
}

/** internal 工具定义（系统工具 + 可选 bash）；入表请走 registry.drain。 */
export function createInternalToolDefs(kernel: Kernel, opts: InternalToolWiringOptions = {}): ToolCapability[] {
  return createInternalTools({
    host: createSystemToolHost(kernel),
    ...(opts.bash !== undefined ? { bash: opts.bash } : {}),
  })
}

/**
 * 工具记录 sink（唯一接线点）：工具执行三相位（called/success/error）→
 * 事件流 `tool` 变体 + 仓库工具记录/历史行。
 */
export function attachToolRecordSink(
  kernel: Kernel,
  registry: ToolCapabilityRegistry,
  toolOutputLimit?: number,
): void {
  registry.setRecordSink((record, ctx) => {
    kernel.events.emit({
      type: 'tool',
      agentId: ctx.agentId,
      tool: record.invocation.name,
      phase: record.status,
      at: record.at,
    })
    forget(
      kernel.contextManager.markToolActivity(ctx.agentId),
      'main:markToolActivity',
      (event) => kernel.logger.log(event),
    )
    if (record.status === 'success' && record.result) {
      if (record.result.metadata?.contextWait) return
      forget(
        kernel.contextManager.appendHistory(ctx.agentId, {
          role: 'tool',
          content: formatToolOutput(record.result, { outputLimit: toolOutputLimit }),
          toolCallId: record.invocation.id,
        }),
        'main:appendToolHistory',
        (event) => kernel.logger.log(event),
      )
    } else if (record.status === 'error') {
      const error = record.error ?? {
        kind: 'execution_failed' as const,
        tool: record.invocation.name,
        message: '工具执行失败',
      }
      forget(
        kernel.contextManager.appendHistory(ctx.agentId, {
          role: 'tool',
          content: formatToolOutput(error, { outputLimit: toolOutputLimit }),
          toolCallId: record.invocation.id,
        }),
        'main:appendToolError',
        (event) => kernel.logger.log(event),
      )
    }
  })
}
