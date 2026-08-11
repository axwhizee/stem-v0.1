// ============================================================
// core/tools/ToolCapabilityRegistry.ts —— 工具注册与执行（工具引擎）
//
// 一切工具统一注册（业务 oc_* / 系统 agent_* / 上下文 context_* /
// 日志 telemetry_* / 模块 module_*，未来 mcp_*/skill_*），
// 权限过滤由 materialize 完成，执行时再做一次权限/参数校验，
// 生命周期钩子（ToolHooks）提供横切扩展点。
//
// 依赖方向：infra（tools）→ gateway（ToolDefinition 形状），
// 不依赖 kernel；AgentRuntime 在上层消费本接口。
// ============================================================

import type { ToolDefinition } from '../gateway'
import type { PermissionLevel } from '../types'
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
import { LevelPermissionResolver } from './types'
import type { PermissionResolver } from './types'
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
  /** 按调用方权限过滤，物化为 LLM 工具定义（schema）。 */
  readonly materialize: (permission: PermissionLevel, filter?: ToolListFilter) => readonly ToolDefinition[]
  /** 执行：查工具 → 权限校验 → 参数校验 → 钩子 → 执行器。 */
  readonly execute: (invocation: ToolInvocation, ctx: ToolContext) => Promise<ToolResult>
  /** 装配工具调用自动记录（组合根注入 → 邮局）。 */
  readonly setRecordSink: (onRecord?: (record: ToolRecord, ctx: ToolContext) => void | Promise<void>) => void
}

export interface ToolRegistryOptions {
  readonly permissionResolver?: PermissionResolver
  readonly hooks?: ToolHooks
  /**
   * 工具调用自动记录（触发 / 成功 / 失败时调用）。
   * 由组合根（kernel）注入 → 转发给邮局，不依赖 runtime 手动发送。
   */
  readonly onRecord?: (record: ToolRecord, ctx: ToolContext) => void | Promise<void>
}

export class DefaultToolCapabilityRegistry implements ToolCapabilityRegistry {
  private readonly tools = new Map<string, ToolCapability>()
  private readonly permissionResolver: PermissionResolver
  private readonly hooks?: ToolHooks
  private onRecord?: (record: ToolRecord, ctx: ToolContext) => void | Promise<void>

  constructor(options: ToolRegistryOptions = {}) {
    this.permissionResolver = options.permissionResolver ?? new LevelPermissionResolver()
    this.hooks = options.hooks
    this.onRecord = options.onRecord
  }

  setRecordSink(onRecord?: (record: ToolRecord, ctx: ToolContext) => void | Promise<void>): void {
    this.onRecord = onRecord
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

  materialize(permission: PermissionLevel, filter?: ToolListFilter): readonly ToolDefinition[] {
    const result: ToolDefinition[] = []
    for (const tool of this.tools.values()) {
      if (filter?.category !== undefined && tool.category !== filter.category) continue
      if (!this.permissionResolver.canExecute(tool, { agentPermission: permission } as ToolContext)) continue
      result.push({ name: tool.id, description: tool.description, parameters: tool.parameters })
    }
    return result
  }

  async execute(invocation: ToolInvocation, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(invocation.name)
    if (!tool) throw toolError({ kind: 'tool_not_found', tool: invocation.name })

    if (!this.permissionResolver.canExecute(tool, ctx)) {
      throw toolError({
        kind: 'permission_denied',
        tool: tool.id,
        required: tool.permission,
        actual: ctx.agentPermission,
      })
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
      const result = await tool.execute(invocation.input, ctx)
      await record('success', { result })
      await this.hooks?.onAfterExecute?.(invocation, tool, ctx, result)
      return result
    } catch (cause) {
      const error: ToolError =
        cause !== null && typeof cause === 'object' && 'kind' in cause
          ? (cause as ToolError)
          : { kind: 'execution_failed', tool: tool.id, message: cause instanceof Error ? cause.message : String(cause), cause }
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
