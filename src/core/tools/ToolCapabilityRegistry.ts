// ============================================================
// core/tools/ToolCapabilityRegistry.ts —— 工具注册与执行（注册表 = 总工具表）
//
// 一切工具统一注册（业务 mail_* / 系统 agent_*/context_* / extension / MCP 投影）。
//
// **注册即声明**（工具模型唯一数据源）：每个 ToolCapability 必带 registerAccess
//（注册声明，编译期强制盘点，无兜底）。就绪只经 **drain**：
// register + init 可追加 → 队列耗尽后工具表冻结（无热插拔）。
//
// 工具访问统一模型（权限融合进 tools）：
//   - materialize(agentId)：经 AccessResolver 端口向族谱台账查询生效访问，
//     链上无显式判定 → 落注册声明；**模型可见清单 = allow ∪ ask**；
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
  ToolInitContext,
  ToolInvocation,
  ToolRecord,
  ToolResult,
} from './types'
import { validateArgs } from './validate'

export interface ToolListFilter {
  readonly category?: ToolCategory
}

export interface ToolDrainIssue {
  readonly tool: string
  readonly message: string
}

export interface ToolCapabilityRegistry {
  /**
   * 注册工具（注册声明随 tool.registerAccess 写入）。
   * `replace: true` = 同名覆盖（drain 期内隐式允许；测试/深度定制通道）；
   * 缺省 = 同名冲突抛错。**drain 完成后工具表冻结**，再 register 抛错。
   */
  readonly register: (tool: ToolCapability, opts?: { readonly replace?: boolean }) => Promise<void>
  readonly unregister: (id: string) => Promise<void>
  readonly get: (id: string) => Promise<ToolCapability>
  readonly list: (filter?: ToolListFilter) => Promise<ToolCapability[]>
  /**
   * 注册声明表：访问键 → 注册时声明（共享键多工具取严）。
   * 收敛链的输入面：根/类/策略/实例清单逐键不得超过本表封顶。
   */
  readonly registerAccessTable: () => Readonly<Record<string, ToolAccess>>
  /** 某访问键的注册声明（未注册键 = undefined——config 点名解析用）。 */
  readonly registerAccessOf: (accessKey: string) => ToolAccess | undefined
  /** 物化为 LLM 工具定义（schema）：按调用方生效访问过滤（deny/ignore 不暴露）。 */
  readonly materialize: (agentId: string, filter?: ToolListFilter) => readonly ToolDefinition[]
  /** 执行：查工具 → 访问确认 → 参数校验 → 执行器。 */
  readonly execute: (invocation: ToolInvocation, ctx: ToolContext) => Promise<ToolResult>
  /** 装配族谱权限查询端口（kernel 接线 AccessLedger；组合根注入点）。 */
  readonly setAccessResolver: (resolver?: AccessResolver) => void
  /**
   * 工具 drain（唯一初始化执行面）：对 seed 逐个 register + init；
   * init 可经 ctx.registerMore 追加；队列耗尽后**冻结**工具表。
   * 单工具 init 失败 = issue 留痕，不中断。
   */
  readonly drain: (
    seed: readonly ToolCapability[],
    ctx: { readonly fs?: ToolInitContext['fs']; readonly projectRoot?: string; readonly log?: ToolInitContext['log'] },
    opts?: { readonly freeze?: boolean },
  ) => Promise<readonly ToolDrainIssue[]>
  /** 工具表是否已冻结（drain 完成且 freeze）。 */
  readonly frozen: () => boolean
  /** 逐工具调用 dispose（系统收尾；失败不阻断）。 */
  readonly disposeAll: () => Promise<void>
  /** 装配工具调用自动记录（组合根注入 → 邮局）。 */
  readonly setRecordSink: (onRecord?: (record: ToolRecord, ctx: ToolContext) => void | Promise<void>) => void
  /** 装配工具调用日志（组合根注入 → bus → core/logging）。 */
  readonly setLogSink: (onLog?: LogSink) => void
  /** 装配访问确认（组合根注入 → AccessAskBus）。 */
  readonly setAccessSink: (access?: AccessAskBus) => void
}

export interface ToolRegistryOptions {
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
  private isFrozen = false
  private onRecord?: (record: ToolRecord, ctx: ToolContext) => void | Promise<void>
  private onLog?: LogSink
  private access?: AccessAskBus
  private resolver?: AccessResolver

  constructor(options: ToolRegistryOptions = {}) {
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

  frozen(): boolean {
    return this.isFrozen
  }

  async register(tool: ToolCapability, opts?: { readonly replace?: boolean }): Promise<void> {
    if (this.isFrozen) {
      throw { kind: 'tool_already_registered', tool: tool.id } satisfies ToolError
    }
    assertToolShape(tool)
    if (this.tools.has(tool.id) && opts?.replace !== true) {
      throw { kind: 'tool_already_registered', tool: tool.id } satisfies ToolError
    }
    this.tools.set(tool.id, tool)
  }

  async drain(
    seed: readonly ToolCapability[],
    ctx: { readonly fs?: ToolInitContext['fs']; readonly projectRoot?: string; readonly log?: ToolInitContext['log'] },
    opts?: { readonly freeze?: boolean },
  ): Promise<readonly ToolDrainIssue[]> {
    if (this.isFrozen) {
      return [{ tool: '', message: '工具表已冻结，不可再次 drain' }]
    }
    const issues: ToolDrainIssue[] = []
    const queue: ToolCapability[] = [...seed]
    const registerMore = (tool: ToolCapability): void => {
      queue.push(tool)
    }
    const initCtx: ToolInitContext = {
      ...(ctx.fs !== undefined ? { fs: ctx.fs } : {}),
      ...(ctx.projectRoot !== undefined ? { projectRoot: ctx.projectRoot } : {}),
      ...(ctx.log !== undefined ? { log: ctx.log } : {}),
      registerMore,
    }
    while (queue.length > 0) {
      const tool = queue.shift()!
      try {
        assertToolShape(tool)
        this.tools.set(tool.id, tool)
      } catch (cause) {
        issues.push({ tool: tool.id ?? '', message: cause instanceof Error ? cause.message : String(cause) })
        continue
      }
      try {
        await tool.init?.(initCtx)
      } catch (cause) {
        issues.push({ tool: tool.id, message: cause instanceof Error ? cause.message : String(cause) })
      }
    }
    if (opts?.freeze !== false) this.isFrozen = true
    return issues
  }

  async disposeAll(): Promise<void> {
    for (const tool of this.tools.values()) {
      if (tool.dispose === undefined) continue
      try {
        await tool.dispose()
      } catch {
        // 收尾失败不阻断
      }
    }
  }

  async unregister(id: string): Promise<void> {
    if (!this.tools.has(id)) throw { kind: 'tool_not_found', tool: id } satisfies ToolError
    this.tools.delete(id)
  }

  async get(id: string): Promise<ToolCapability> {
    const tool = this.tools.get(id)
    if (!tool) throw ({ kind: 'tool_not_found', tool: id })
    return tool
  }

  async list(filter?: ToolListFilter): Promise<ToolCapability[]> {
    const all = [...this.tools.values()]
    if (!filter?.category) return all
    return all.filter((t) => t.category === filter.category)
  }

  registerAccessTable(): Readonly<Record<string, ToolAccess>> {
    // 注册行为生成的总工具表：访问键 → 注册声明（共享键多工具**取严**——
    // 封顶保守不越权；表极小，线性折叠即可）。
    const table: Record<string, ToolAccess> = {}
    for (const tool of this.tools.values()) {
      const key = tool.accessKey ?? tool.id
      const prev = table[key]
      table[key] = prev === undefined ? tool.registerAccess : restrictAccess(prev, tool.registerAccess)
    }
    return table
  }

  registerAccessOf(accessKey: string): ToolAccess | undefined {
    let acc: ToolAccess | undefined
    for (const tool of this.tools.values()) {
      if ((tool.accessKey ?? tool.id) !== accessKey) continue
      acc = acc === undefined ? tool.registerAccess : restrictAccess(acc, tool.registerAccess)
    }
    return acc
  }

  materialize(agentId: string, filter?: ToolListFilter): readonly ToolDefinition[] {
    const result: ToolDefinition[] = []
    for (const tool of this.tools.values()) {
      if (filter?.category !== undefined && tool.category !== filter.category) continue
      const accessKey = tool.accessKey ?? tool.id
      // 族谱台账查询（生效权限 = 族谱位置的函数）；链上无判定 → 注册声明
      // （**kind 不参与推断**——注册即封顶，无兜底表）。
      const action = this.resolver?.accessOf(agentId, accessKey) ?? tool.registerAccess
      // 模型可见清单 = allow ∪ ask；deny 出局；ignore = 背景在场（不设防）。
      if (action === 'deny' || action === 'ignore') continue
      result.push({ name: tool.id, description: tool.description, parameters: tool.parameters })
    }
    return result
  }

  async execute(invocation: ToolInvocation, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(invocation.name)
    if (!tool) throw ({ kind: 'tool_not_found', tool: invocation.name })

    // 访问统一确认（allow/ignore 通过 / deny 拒绝 / ask 挂起等根信箱回复）。
    const accessKey = tool.accessKey ?? tool.id
    try {
      await this.access?.assert({
        accessKey,
        agentId: ctx.agentId,
        registerAccess: tool.registerAccess,
        metadata: { tool: tool.id },
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      })
    } catch (cause) {
      const error = cause as { kind?: string; accessKey?: string; feedback?: string }
      if (error?.kind === 'access_denied') {
        throw ({ kind: 'access_denied', tool: tool.id, accessKey })
      }
      if (error?.kind === 'access_rejected') {
        throw ({
          kind: 'access_rejected',
          tool: tool.id,
          accessKey,
          ...(typeof error.feedback === 'string' ? { feedback: error.feedback } : {}),
        })
      }
      if (error?.kind === 'access_timeout') {
        throw ({ kind: 'access_timeout', tool: tool.id, accessKey })
      }
      if (error?.kind === 'access_aborted') {
        throw ({ kind: 'access_aborted', tool: tool.id, accessKey })
      }
      throw cause
    }

    const customError = tool.validate?.(invocation.input)
    if (customError !== undefined) {
      throw ({ kind: 'invalid_arguments', tool: tool.id, message: customError })
    }
    const schemaError = validateArgs(invocation.input, tool.parameters)
    if (schemaError !== undefined) {
      throw ({ kind: 'invalid_arguments', tool: tool.id, message: schemaError })
    }
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
      return result
    } catch (cause) {
      // 领域错误（KernelError 等带 kind）原样透传——工具层是通道不是转换器；
      // 非结构化异常收成 execution_failed（errorBrief 防 [object Object]）。
      const error: ToolError =
        cause !== null && typeof cause === 'object' && 'kind' in cause && typeof (cause as { kind: unknown }).kind === 'string'
          ? (cause as ToolError)
          : {
              kind: 'execution_failed',
              tool: tool.id,
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }
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

