// ============================================================
// core/main/toolWiring.ts —— internal 工具装配 + 工具记录 sink 接线（组合根）
//
// 两件装配职责从 Kernel 构造器上移：
//   1. `registerInternalTools`：经 `createInternalTools`（internal 唯一出入口）
//      装载系统工具 + （注入 ShellRunner 才装配的）bash——Kernel 不再认识 bash；
//   2. `attachToolRecordSink`：工具执行三相位 → 事件流 tool 变体 + 仓库记录/历史行。
//
// 实现经 Kernel **公开面**（events/contextManager/logger）接线，kernel 侧
// 保持与 main 的单向依赖（main → kernel），无反向 import。
// ============================================================

import type { Kernel } from '../kernel'
import { createSystemToolHost } from '../kernel'
import type { BashToolSettings, ShellRunner, ToolCapabilityRegistry } from '../tools'
import { formatToolOutput } from '../tools'
import { createInternalTools } from '../tools/internal'
import { forget } from '../logging'

export interface InternalToolWiringOptions {
  /** bash 端口（宿主注入 ShellRunner 才装配；core 零平台依赖）。 */
  readonly bash?: { readonly runner: ShellRunner; readonly settings?: BashToolSettings }
}

/**
 * 装配 internal 工具（系统工具 + 可选 bash）到注册表。
 * 唯一出入口 `createInternalTools`；bash 端口缺省 = 不装配 bash（事故半径收口）。
 */
export async function registerInternalTools(
  kernel: Kernel,
  registry: ToolCapabilityRegistry,
  opts: InternalToolWiringOptions = {},
): Promise<void> {
  const tools = createInternalTools({
    host: createSystemToolHost(kernel),
    ...(opts.bash !== undefined ? { bash: opts.bash } : {}),
  })
  for (const tool of tools) await registry.register(tool)
}

/**
 * 工具记录 sink（唯一接线点）：工具执行三相位（called/success/error）→
 * 事件流 `tool` 变体（实时监督，只带名字/相位）+ 仓库工具记录/历史行。
 *
 * 上下文回填规则与历史实现一致：success 且非 `contextWait` 挂起通道 → 结果落
 * `tool` 行；error → 错误成形落 `tool` 行；`contextWait`（wait/pause）等待正规
 * 填充，不重复 append。
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
      if (record.result.metadata?.contextWait) return // 挂起通道（wait/pause）：等待填充，不 append
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
