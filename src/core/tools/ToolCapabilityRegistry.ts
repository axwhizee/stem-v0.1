// ============================================================
// core/tools/ToolCapabilityRegistry.ts —— 工具注册与执行（工具引擎）
//
// 一切工具统一注册（业务 oc_* / 系统 agent_* / 上下文 context_* /
// 日志 telemetry_* / 模块 module_*，未来 mcp_*/skill_*）。
//
// 权限统一模型（见 core/permission）：
//   - materialize(rules)：按调用方权限规则过滤工具可见性（deny 不暴露）；
//   - execute：registry 层统一确认（setPermissionSink 注入 PermissionManager）
//     → allow 执行 / deny 抛 permission_denied / ask 挂起等用户回复。
//   - 工具无需内部调权限接口（external_directory 已简化掉）。
//
// 依赖方向：infra（tools）→ gateway（ToolDefinition 形状），
// 不依赖 kernel；AgentRuntime 在上层消费本接口。
// ============================================================

import type { ToolDefinition } from '../gateway'
import type { LogSink } from '../logging'
import type { PermissionManager, PermissionRules } from '../permission'
import { evaluate } from '../permission'
import type {
  ToolCapability,
  ToolCategory,
  ToolContext,
  ToolError,
  ToolHooks,
  ToolInvocation,
  ToolRecord,
  ToolResult,
} from './types'
import { validateArgs } from './validate'

export interface ToolListFilter {
  readonly category?: ToolCategory
}

export interface ToolCapabilityRegistry {
  /** 注册工具（业务/系统/上下文/日志/模块统一入口）。 */
  readonly register: (tool: ToolCapability) => Promise<void>
  readonly unregister: (id: string) => Promise<void>
  readonly get: (id: string) => Promise<ToolCapability>
  readonly list: (filter?: ToolListFilter) => Promise<ToolCapability[]>
  /** 按调用方权限规则过滤，物化为 LLM 工具定义（schema）；deny 的工具不暴露。 */
  readonly materialize: (rules: PermissionRules, filter?: ToolListFilter) => readonly ToolDefinition[]
  /** 执行：查工具 → 权限确认 → 参数校验 → 钩子 → 执行器。 */
  readonly execute: (invocation: ToolInvocation, ctx: ToolContext) => Promise<ToolResult>
  /** 装配工具调用自动记录（组合根注入 → 邮局）。 */
  readonly setRecordSink: (onRecord?: (record: ToolRecord, ctx: ToolContext) => void | Promise<void>) => void
  /** 装配工具调用日志（组合根注入 → bus → core/logging）。 */
  readonly setLogSink: (onLog?: LogSink) => void
  /** 装配权限确认（组合根注入 → PermissionManager）。 */
  readonly setPermissionSink: (permission?: PermissionManager) => void
}

export interface ToolRegistryOptions {
  readonly hooks?: ToolHooks
  /**
   * 工具调用自动记录（触发 / 成功 / 失败时调用）。
   * 由组合根（kernel）注入 → 转发给邮局，不依赖 runtime 手动发送。
   */
  readonly onRecord?: (record: ToolRecord, ctx: ToolContext) => void | Promise<void>
  /** 工具调用日志（组合根注入 → bus → core/logging）。 */
  readonly onLog?: LogSink
  /** 权限确认（组合根注入 → PermissionManager）。 */
  readonly permission?: PermissionManager
}

export class DefaultToolCapabilityRegistry implements ToolCapabilityRegistry {
  private readonly tools = new Map<string, ToolCapability>()
  private readonly hooks?: ToolHooks
  private onRecord?: (record: ToolRecord, ctx: ToolContext) => void | Promise<void>
  private onLog?: LogSink
  private permission?: PermissionManager

  constructor(options: ToolRegistryOptions = {}) {
    this.hooks = options.hooks
    this.onRecord = options.onRecord
    this.onLog = options.onLog
    this.permission = options.permission
  }

  setRecordSink(onRecord?: (record: ToolRecord, ctx: ToolContext) => void | Promise<void>): void {
    this.onRecord = onRecord
  }

  setLogSink(onLog?: LogSink): void {
    this.onLog = onLog
  }

  setPermissionSink(permission?: PermissionManager): void {
    this.permission = permission
  }

  async register(tool: ToolCapability): Promise<void> {
    assertToolShape(tool)
    if (this.tools.has(tool.id)) {
      throw toolError({ kind: 'tool_already_registered', tool: tool.id })
    }
    this.tools.set(tool.id, tool)
  }

  async unregister(id: string): Promise<void> {
    if (!this.tools.has(id)) throw toolError({ kind: 'tool_not_found', tool: id })
    this.tools.delete(id)
  }

  async get(id: string): Promise<ToolCapability> {
    const tool = this.tools.get(id)
    if (!tool) throw toolError({ kind: 'tool_not_found', tool: id })
    return tool
  }

  async list(filter?: ToolListFilter): Promise<ToolCapability[]> {
    const all = [...this.tools.values()]
    if (!filter?.category) return all
    return all.filter((t) => t.category === filter.category)
  }

  materialize(rules: PermissionRules, filter?: ToolListFilter): readonly ToolDefinition[] {
    const result: ToolDefinition[] = []
    for (const tool of this.tools.values()) {
      if (filter?.category !== undefined && tool.category !== filter.category) continue
      const permissionName = tool.permission ?? tool.id
      // deny 的工具不暴露给模型（ask/allow 均可暴露，执行时才确认）。
      if (evaluate(permissionName, rules) === 'deny') continue
      result.push({ name: tool.id, description: tool.description, parameters: tool.parameters })
    }
    return result
  }

  async execute(invocation: ToolInvocation, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(invocation.name)
    if (!tool) throw toolError({ kind: 'tool_not_found', tool: invocation.name })

    // 权限统一确认（allow 通过 / deny 拒绝 / ask 挂起等面板回复）。
    const permissionName = tool.permission ?? tool.id
    try {
      await this.permission?.assert({
        permission: permissionName,
        agentId: ctx.agentId,
        rules: ctx.rules ?? [],
        metadata: { tool: tool.id },
      })
    } catch (cause) {
      const error = cause as { kind?: string; permission?: string; feedback?: string }
      if (error?.kind === 'permission_denied') {
        throw toolError({ kind: 'permission_denied', tool: tool.id, permission: permissionName })
      }
      if (error?.kind === 'permission_rejected') {
        throw toolError({
          kind: 'permission_rejected',
          tool: tool.id,
          permission: permissionName,
          ...(typeof error.feedback === 'string' ? { feedback: error.feedback } : {}),
        })
      }
      throw cause
    }

    const customError = tool.validate?.(invocation.input)
    if (customError !== undefined) {
      throw toolError({ kind: 'invalid_arguments', tool: tool.id, message: customError })
    }
    const schemaError = validateArgs(invocation.input, tool.parameters)
    if (schemaError !== undefined) {
      throw toolError({ kind: 'invalid_arguments', tool: tool.id, message: schemaError })
    }

    await this.hooks?.onBeforeExecute?.(invocation, tool, ctx)
    const startedAt = Date.now()
    this.onLog?.log({
      type: 'tool.invoked',
      at: startedAt,
      agentId: ctx.agentId,
      tool: tool.id,
      args: invocation.input,
      phase: 'called',
    })
    const record = async (status: ToolRecord['status'], extra?: Partial<ToolRecord>) => {
      await this.onRecord?.(
        {
          invocation,
          ctx,
          status,
          at: Date.now(),
          ...extra,
        },
        ctx,
      )
    }
    await record('called')
    try {
      const result = await tool.execute(invocation.input, { ...ctx, callId: invocation.id })
      this.onLog?.log({
        type: 'tool.invoked',
        at: Date.now(),
        agentId: ctx.agentId,
        tool: tool.id,
        args: invocation.input,
        phase: 'success',
        durationMs: Date.now() - startedAt,
        resultText: result.text,
      })
      await record('success', { result })
      await this.hooks?.onAfterExecute?.(invocation, tool, ctx, result)
      return result
    } catch (cause) {
      const error: ToolError =
        cause !== null && typeof cause === 'object' && 'kind' in cause
          ? (cause as ToolError)
          : { kind: 'execution_failed', tool: tool.id, message: cause instanceof Error ? cause.message : String(cause), cause }
      this.onLog?.log({
        type: 'tool.invoked',
        at: Date.now(),
        agentId: ctx.agentId,
        tool: tool.id,
        args: invocation.input,
        phase: 'error',
        durationMs: Date.now() - startedAt,
        errorKind: error.kind,
      })
      await record('error', { error })
      await this.hooks?.onError?.(invocation, tool, ctx, error)
      throw error
    }
  }
}

function assertToolShape(tool: ToolCapability): void {
  if (!tool.id || typeof tool.id !== 'string') throw invalid(`工具 id 不能为空`)
  if (!tool.description) throw invalid(`工具 ${tool.id} 缺少 description`)
  if (typeof tool.execute !== 'function') throw invalid(`工具 ${tool.id} 缺少 execute 实现`)
  if (tool.parameters?.type !== 'object') throw invalid(`工具 ${tool.id} 的 parameters 必须是 object schema`)
}

function invalid(message: string): ToolError {
  return { kind: 'execution_failed', tool: '', message }
}

function toolError(e: ToolError): ToolError {
  return e
}
