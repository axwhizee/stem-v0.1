// ============================================================
// core/tools/ToolCapabilityRegistry.ts —— 工具注册与执行（注册表 = 总工具表）
//
// 一切工具统一注册（业务 mail_* / 系统 agent_* / 上下文 context_* /
// 日志 telemetry_* / 模块 module_*，未来 mcp_*/skill_*）。
//
// **注册即出生声明**（工具模型唯一数据源）：每个 ToolCapability 必带
// birth 字段（编译期强制盘点，无兜底）；注册行为生成总工具表——
// 键 → 出生值（多工具共享访问键时取严）。出生值是收敛链的全局面封顶。
//
// 工具访问统一模型（权限融合进 tools）：
//   - materialize(agentId)：经 AccessResolver 端口向族谱台账查询生效访问，
//     链上无显式判定 → 落出生值；**模型可见清单 = allow ∪ ask**；
//   - execute：registry 层统一确认（setAccessSink 注入 AccessAskBus）
//     → allow/ignore 执行 / deny 抛 access_denied / ask 挂起等根回复。
//
// 依赖方向：infra（tools）→ gateway（ToolDefinition 形状）；
// 权限查询走注入端口（AccessResolver，kernel 接 lineage/AccessLedger），
// 不 import kernel/lineage；Runtime 在上层消费本接口。
// ============================================================

import type { ToolDefinition } from '../gateway'
import type { LogSink } from '../logging'
import type { AccessAskBus } from './accessRequest'
import { restrictAccess } from './access'
import type {
  AccessResolver,
  ToolAccess,
  ToolCapability,
  ToolCategory,
  ToolContext,
  ToolError,
  ToolHooks,
  ToolInitContext,
  ToolInvocation,
  ToolRecord,
  ToolResult,
} from './types'
import { validateArgs } from './validate'

export interface ToolListFilter {
  readonly category?: ToolCategory
}

export interface ToolCapabilityRegistry {
  /**
   * 注册工具（注册即出生声明——tool.birth 编译期必填）。
   * `replace: true` = 同名覆盖（装载律：后装载层覆盖前层）；
   * 缺省 = 同名冲突抛错（代码注册路径的防呆不变）。
   */
  readonly register: (tool: ToolCapability, opts?: { readonly replace?: boolean }) => Promise<void>
  readonly unregister: (id: string) => Promise<void>
  readonly get: (id: string) => Promise<ToolCapability>
  readonly list: (filter?: ToolListFilter) => Promise<ToolCapability[]>
  /**
   * 出生表（注册行为生成的总工具表）：访问键 → 出生值（共享键多工具取严）。
   * 收敛链的输入面：根清单/类清单/策略清单/实例清单逐键不得超过本表封顶。
   */
  readonly birthTable: () => Readonly<Record<string, ToolAccess>>
  /** 某访问键的出生值（未注册键 = undefined——config 点名解析用）。 */
  readonly birthOf: (accessKey: string) => ToolAccess | undefined
  /** 物化为 LLM 工具定义（schema）：按调用方生效访问过滤（deny/ignore/未声明 internal 不暴露）。 */
  readonly materialize: (agentId: string, filter?: ToolListFilter) => readonly ToolDefinition[]
  /** 执行：查工具 → 访问确认 → 参数校验 → 钩子 → 执行器。 */
  readonly execute: (invocation: ToolInvocation, ctx: ToolContext) => Promise<ToolResult>
  /** 装配族谱权限查询端口（kernel 接线 AccessLedger；组合根注入点）。 */
  readonly setAccessResolver: (resolver?: AccessResolver) => void
  /** 调用所有已注册工具的 init（系统装配完成后调用一次；幂等由工具自身保证）。 */
  readonly initAll: (ctx: ToolInitContext) => Promise<void>
  /** 装配工具调用自动记录（组合根注入 → 邮局）。 */
  readonly setRecordSink: (onRecord?: (record: ToolRecord, ctx: ToolContext) => void | Promise<void>) => void
  /** 装配工具调用日志（组合根注入 → bus → core/logging）。 */
  readonly setLogSink: (onLog?: LogSink) => void
  /** 装配访问确认（组合根注入 → AccessAskBus）。 */
  readonly setAccessSink: (access?: AccessAskBus) => void
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
  /** 访问确认（组合根注入 → AccessAskBus）。 */
  readonly access?: AccessAskBus
  /** 族谱权限查询端口（组合根注入 → lineage/AccessLedger）。 */
  readonly resolver?: AccessResolver
}

export class DefaultToolCapabilityRegistry implements ToolCapabilityRegistry {
  private readonly tools = new Map<string, ToolCapability>()
  private readonly hooks?: ToolHooks
  private onRecord?: (record: ToolRecord, ctx: ToolContext) => void | Promise<void>
  private onLog?: LogSink
  private access?: AccessAskBus
  private resolver?: AccessResolver

  constructor(options: ToolRegistryOptions = {}) {
    this.hooks = options.hooks
    this.onRecord = options.onRecord
    this.onLog = options.onLog
    this.access = options.access
    this.resolver = options.resolver
  }

  setRecordSink(onRecord?: (record: ToolRecord, ctx: ToolContext) => void | Promise<void>): void {
    this.onRecord = onRecord
  }

  setLogSink(onLog?: LogSink): void {
    this.onLog = onLog
  }

  setAccessSink(access?: AccessAskBus): void {
    this.access = access
  }

  setAccessResolver(resolver?: AccessResolver): void {
    this.resolver = resolver
  }

  async register(tool: ToolCapability, opts?: { readonly replace?: boolean }): Promise<void> {
    assertToolShape(tool)
    if (this.tools.has(tool.id) && opts?.replace !== true) {
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

  birthTable(): Readonly<Record<string, ToolAccess>> {
    // 注册行为生成的总工具表：访问键 → 出生值（共享键多工具**取严**——
    // 封顶保守不越权；表极小，线性折叠即可）。
    const table: Record<string, ToolAccess> = {}
    for (const tool of this.tools.values()) {
      const key = tool.accessKey ?? tool.id
      const prev = table[key]
      table[key] = prev === undefined ? tool.birth : restrictAccess(prev, tool.birth)
    }
    return table
  }

  birthOf(accessKey: string): ToolAccess | undefined {
    let acc: ToolAccess | undefined
    for (const tool of this.tools.values()) {
      if ((tool.accessKey ?? tool.id) !== accessKey) continue
      acc = acc === undefined ? tool.birth : restrictAccess(acc, tool.birth)
    }
    return acc
  }

  async initAll(ctx: ToolInitContext): Promise<void> {
    for (const tool of this.tools.values()) {
      await tool.init?.(ctx)
    }
  }

  materialize(agentId: string, filter?: ToolListFilter): readonly ToolDefinition[] {
    const result: ToolDefinition[] = []
    for (const tool of this.tools.values()) {
      if (filter?.category !== undefined && tool.category !== filter.category) continue
      const accessKey = tool.accessKey ?? tool.id
      // 族谱台账查询（生效权限 = 族谱位置的函数）；链上无判定 → 出生值
      // （**kind 不参与推断**——出生即封顶，无兜底表）。
      const action = this.resolver?.accessOf(agentId, accessKey) ?? tool.birth
      // 模型可见清单 = allow ∪ ask；deny 出局；ignore = 背景在场（不设防）。
      if (action === 'deny' || action === 'ignore') continue
      result.push({ name: tool.id, description: tool.description, parameters: tool.parameters })
    }
    return result
  }

  async execute(invocation: ToolInvocation, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(invocation.name)
    if (!tool) throw toolError({ kind: 'tool_not_found', tool: invocation.name })

    // 访问统一确认（allow/ignore 通过 / deny 拒绝 / ask 挂起等根信箱回复）。
    const accessKey = tool.accessKey ?? tool.id
    try {
      await this.access?.assert({
        accessKey,
        agentId: ctx.agentId,
        birth: tool.birth,
        metadata: { tool: tool.id },
      })
    } catch (cause) {
      const error = cause as { kind?: string; accessKey?: string; feedback?: string }
      if (error?.kind === 'access_denied') {
        throw toolError({ kind: 'access_denied', tool: tool.id, accessKey })
      }
      if (error?.kind === 'access_rejected') {
        throw toolError({
          kind: 'access_rejected',
          tool: tool.id,
          accessKey,
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
