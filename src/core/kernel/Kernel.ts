// ============================================================
// core/kernel/Kernel.ts —— Kernel 组合根（core 内部装配）
//
// 装配：模板注册表 / 实例管理 / 空间 / 族谱树 / 上下文仓库+管理员+快递员
//      / 运行时 / 工具访问管理器 / 工具注册表。
//
// 通信模型（重建邮局，无总线）：
//   - sendMessage(from, to, payload) → 管理员 deposit（打戳 + 入库 + 触发处理）；
//   - 事件（stream/letter/status/notice）统一经 events hub 发布（PilotEvent）；
//   - 访问确认（ask）消息化：投递申请到根信箱 + access_reply 工具解析（见 tools/accessRequest）。
// 参与者查询：复用 instances + user0（无独立注册表）。
// user0 是元 agent（族谱树根 parentId=null）。
// ============================================================

import type { ModelGateway } from '../gateway'
import type { LLMEvent, ModelRef, UsageEvent } from '../gateway'
import type { ContextAssembler, MailDelivery, Repository, Courier } from '../context'
import { DefaultRepository, DefaultCourier, DefaultContextManager } from '../context'
import type { ContextManager } from '../context'
import type { Logger } from '../logging'
import { InMemoryLogger } from '../logging'
import type { LogEvent } from '../logging'
import type { AccessAskBus, ToolAccess, ToolAccessRules } from '../tools'
import { DefaultAccessAskBus, toolAccessToRules, collectAncestorAccessLayers, formatAccessRequest } from '../tools'
import type { EventHub, PilotEvent } from '../events'
import { DefaultEventHub } from '../events'
import type { ToolCapabilityRegistry, ToolContext } from '../tools'
import simpleChatTemplate from '../../../templates/SimpleChat.json'
import coderTemplate from '../../../templates/Coder.json'
import { DefaultTemplateRegistry } from './TemplateRegistry'
import type { TemplateRegistry } from './TemplateRegistry'
import { DefaultInstanceManager } from './InstanceManager'
import type { InstanceManager, InstantiateOptions } from './InstanceManager'
import { DefaultSpaceManager } from './SpaceManager'
import type { SpaceManager } from './SpaceManager'
import { DefaultRuntime } from './Runtime'
import type { Runtime } from './Runtime'
import { DefaultLineageTree } from '../lineage'
import type { LineageTree } from '../lineage'
import { createSystemTools } from './systemTools'
import type { AgentClass, AgentClassID, AgentID, AgentSpaceID, ProjectRef } from './types'
import { makeAgentID } from './types'

/** 内置示例模板（从 templates/*.json 加载，非硬编码角色）。 */
export const BUILTIN_TEMPLATES: readonly AgentClass[] = [
  simpleChatTemplate as unknown as AgentClass,
  coderTemplate as unknown as AgentClass,
]

/** 用户面板固定 id。 */
export const USER_ID = 'user0'

export interface KernelOptions {
  readonly gateway: ModelGateway
  /** 模板未配置 model 时的默认模型。 */
  readonly defaultModel: ModelRef
  /** 覆盖内置模板（缺省用 templates/*.json）。 */
  readonly templates?: readonly AgentClass[]
  /** 工具注册表（缺省不启用工具轮）。 */
  readonly tools?: ToolCapabilityRegistry
  readonly contextAssembler?: ContextAssembler
  readonly defaultCountdownMs?: number
  /** 可注入倒计时实现（测试用）。 */
  readonly timer?: import('../context').TimerFactory
  readonly maxSteps?: number
  readonly estimateCost?: (usage: UsageEvent | undefined) => number
  /** 统一事件流回调（PilotEvent：stream/letter/status/notice；shell/GUI 订阅）。 */
  readonly onEvent?: (event: PilotEvent) => void
  /** 日志记录器（缺省内存版）。 */
  readonly logger?: Logger
  /**
   * 全局默认工具访问（来自配置 `permission`，最弱优先级）。
   * 评估顺序：[全局默认, 祖先链(父→子), agent 类, session 批准]，层间取最严格。
   */
  readonly globalToolAccessDefaults?: Readonly<Record<string, ToolAccess>>
  /** 工具访问自动批准（来自配置 `autoApprove`）：ask 直接放行，不弹窗。 */
  readonly autoApprove?: boolean
}

export class Kernel {
  readonly templates: TemplateRegistry
  readonly instances: InstanceManager
  readonly spaces: SpaceManager
  /** 族谱树（无状态关系查询视图，依赖 instances 实时推导）。 */
  readonly lineage: LineageTree
  /** 上下文仓库（上下文本体的唯一存储）。 */
  readonly repository: Repository
  /** 上下文管理员（处理/打戳/组装）。 */
  readonly contextManager: ContextManager
  /** 快递员（倒计时 + 发送）。 */
  readonly courier: Courier
  readonly runtime: Runtime
  readonly tools?: ToolCapabilityRegistry
  /** 工具访问确认（ask 消息化：投递申请到根信箱 + access_reply 解析）。 */
  readonly access: AccessAskBus
  /** 统一事件流（PilotEvent：stream/letter/status/notice；多订阅者）。 */
  readonly events: EventHub
  /** 日志记录器。 */
  readonly logger: Logger

  constructor(options: KernelOptions) {
    this.templates = new DefaultTemplateRegistry(options.templates ?? BUILTIN_TEMPLATES)
    this.instances = new DefaultInstanceManager(this.templates)
    this.spaces = new DefaultSpaceManager()
    this.tools = options.tools
    this.logger = options.logger ?? new InMemoryLogger()

    // 统一事件流（多订阅者）：外部（shell/GUI）经 onEvent 订阅 stream/letter/status/notice。
    this.events = new DefaultEventHub()
    if (options.onEvent) this.events.subscribe(options.onEvent)

    // 族谱树（无状态视图）：实时基于 instances 推导 parent/children/ancestors。
    this.lineage = new DefaultLineageTree({
      getInstance: (id) => this.instances.getSync(id),
      getAllInstances: () => this.instances.listAllSync(),
    })

    // 工具访问确认（ask 消息化）：投递申请到申请者的族谱根信箱；根经 access_reply 回复。
    this.access = new DefaultAccessAskBus({
      askRoot: (request) =>
        this.contextManager.deposit(
          this.lineage.getRoot(makeAgentID(request.agentId)),
          { role: 'user', content: formatAccessRequest(request) },
          request.agentId,
        ),
      getRoot: (agentId) => this.lineage.getRoot(makeAgentID(agentId)),
      onLog: { log: (event) => this.emitLog(event) },
      autoApprove: options.autoApprove,
    })

    // 重建邮局：仓库（存储）→ 管理员（处理，经 onChange 驱动）→ 快递员（发送）。
    this.repository = new DefaultRepository({ onLog: (event) => this.emitLog(event) })
    this.courier = new DefaultCourier({
      defaultCountdownMs: options.defaultCountdownMs,
      timer: options.timer,
      repository: this.repository,
      onLog: (event) => this.emitLog(event),
    })
    this.contextManager = new DefaultContextManager({
      contextAssembler: options.contextAssembler,
      defaultCountdownMs: options.defaultCountdownMs,
      timer: options.timer,
      repository: this.repository,
      courier: this.courier,
      onLog: (event) => this.emitLog(event),
    })
    // 仓库 onChange → 管理员处理入口。
    this.repository.onChange = (agentId) => this.contextManager.handleChange(agentId)

    this.runtime = new DefaultRuntime({
      gateway: options.gateway,
      instances: this.instances,
      templates: this.templates,
      contextManager: this.contextManager,
      repository: this.repository,
      tools: options.tools,
      defaultModel: options.defaultModel,
      maxSteps: options.maxSteps,
      estimateCost: options.estimateCost,
      onEvent: (agentId, event) => this.events.emit({ type: 'stream', agentId, event }),
      onStatus: (agentId, from, to) => this.events.emit({ type: 'status', agentId, from, to, at: Date.now() }),
      onLog: { log: (event) => this.emitLog(event) },
      // 完整访问层：[全局（最弱）, 祖先链(父→子), agent 类]。
      resolveAccessLayers: (agentId) => [
        options.globalToolAccessDefaults ? toolAccessToRules(options.globalToolAccessDefaults) : [],
        ...collectAncestorAccessLayers(this.lineage.getAncestors(agentId), (id) =>
          this.rulesOf(makeAgentID(id)),
        ),
        this.resolveClassLayer(agentId),
      ],
    })

    // 工具自动记录 → 仓库（触发/成功/失败），不依赖 runtime 手动发送。
    this.tools?.setRecordSink?.((record, ctx) => {
      void this.contextManager.appendToolRecord(ctx.agentId, record)
      if (record.status === 'success' && record.result) {
        if (record.result.metadata?.contextWait) return // context_wait：等待填充，不 append
        void this.contextManager.appendHistory(ctx.agentId, {
          role: 'tool',
          content: record.result.text,
          toolCallId: record.invocation.id,
        })
      } else if (record.status === 'error') {
        const error = record.error
        const message =
          error !== undefined && 'message' in error
            ? `[ToolError ${error.kind}] ${error.message}`
            : '[ToolError execution_failed] 工具执行失败'
        void this.contextManager.appendHistory(ctx.agentId, {
          role: 'tool',
          content: message,
          toolCallId: record.invocation.id,
        })
      }
    })
    // 工具调用日志；访问确认 → AccessManager。
    this.tools?.setLogSink?.({ log: (event) => this.emitLog(event) })
    this.tools?.setAccessSink?.(this.access)
  }

  /** 某 agent 的访问规则（模板 tools + 实例 toolOverride 合并生成）。 */
  private rulesOf(agentId: AgentID): ToolAccessRules {
    const instance = this.instances.getSync(agentId)
    const template = instance ? this.templates.getSync(instance.classRef) : undefined
    if (!template) return []
    const merged = { ...template.tools, ...instance?.toolOverride }
    return toolAccessToRules(merged)
  }

  /** 某 agent 的类访问层（实例 classRef 对应模板的 tools + 实例 toolOverride 合并）。 */
  private resolveClassLayer(agentId: AgentID): ToolAccessRules {
    return this.rulesOf(agentId)
  }

  /** 注册用户面板（user0）：元 agent 实例化（族谱树根 parentId=null）+ 上下文（不组装，只汇总信件）。 */
  async registerUser(displayName = 'User'): Promise<void> {
    // user0 作为元 agent 进入实例体系（族谱树根）。
    await this.instances.registerMetaAgent({ id: makeAgentID(USER_ID), displayName })
    await this.contextManager.register({
      agentId: USER_ID,
      assemble: false,
      onDelivery: (delivery) => {
        if (delivery.kind !== 'user') return
        // 来信统一经事件流发布（letter 事件；含 access_request 消息化申请）。
        this.events.emit({ type: 'letter', agentId: delivery.agentId, letters: delivery.letters, at: Date.now() })
      },
    })
  }

  /** 用户发送消息（默认发往当前选中的 agent）。 */
  async sendUserMessage(agentId: string, text: string): Promise<void> {
    await this.sendMessage(USER_ID, agentId, text)
  }

  /**
   * agent 间通信（无总线，直接投递到上下文管理员）。
   * from/to 为参与者 id（user0 或 agent 实例 id）。
   */
  async sendMessage(from: string, to: string, payload: string): Promise<void> {
    this.emitLog({
      type: 'kernel.message.sent',
      at: Date.now(),
      from,
      to,
      kind: 'agent_message',
      payloadSize: payload.length,
    })
    await this.contextManager.deposit(to, { role: 'user', content: payload }, from)
  }

  /** 实例化：创建实例 + 注册上下文（仓库/管理员/快递员）+ 投递首信。 */
  async instantiateAgent(opts: Omit<InstantiateOptions, 'spaceId'>, project: ProjectRef): Promise<AgentID> {
    const space = await this.spaces.getOrCreate(project)
    return this.instantiateInSpace(opts, space.id)
  }

  /** 实例化（指定空间，供系统工具 agent_instantiate 使用）。 */
  async instantiateInSpace(opts: Omit<InstantiateOptions, 'spaceId'>, spaceId: AgentSpaceID | string): Promise<AgentID> {
    const instance = await this.instances.instantiate({ ...opts, spaceId: spaceId as AgentSpaceID })
    this.emitLog({
      type: 'kernel.instance.created',
      at: Date.now(),
      agentId: instance.id,
      classId: instance.classRef,
      parentId: instance.parentId ?? '',
    })

    const template = await this.templates.get(instance.classRef)
    await this.contextManager.register({
      agentId: instance.id,
      systemPrompt: template.systemPrompt,
      sendCountdownMs: template.sendCountdown,
      assemble: true,
      onDelivery: (delivery) => this.handleDelivery(delivery),
      onHold: (id) => void this.runtime.notifyHold(makeAgentID(id)),
    })

    // 上下文传递：父 agent 指定的仓库消息 id 列表，深拷贝导入新实例上下文空间。
    if (opts.contextRefs && opts.contextRefs.length > 0 && instance.parentId) {
      const parentState = await this.contextManager.getState(instance.parentId)
      for (const ref of opts.contextRefs) {
        const stored = parentState.messages.find((m) => m.id === ref || `${m.turn}` === ref)
        if (stored && stored.message.role !== 'system') {
          await this.contextManager.appendHistory(instance.id, { ...stored.message, content: String(stored.message.content) })
        }
      }
    }

    // userPrompt 作为首封信投递（from=父，管理员打戳）。
    await this.contextManager.deposit(instance.id, { role: 'user', content: instance.userPrompt }, instance.parentId ?? USER_ID)
    return instance.id
  }

  /** 注册系统管理工具（agent_ 与 bus_ 前缀）到工具注册表。 */
  async registerSystemTools(registry: ToolCapabilityRegistry): Promise<void> {
    for (const tool of createSystemTools(this)) {
      await registry.register(tool)
    }
  }

  /** 终止实例：销毁权校验（by 是祖先或 user0）+ 注销上下文 + 实例。 */
  async terminateAgent(agentId: string, opts?: { by?: string; recursive?: boolean }): Promise<void> {
    await this.contextManager.unregister(agentId)
    await this.instances.terminate(makeAgentID(agentId), {
      by: makeAgentID(opts?.by ?? USER_ID),
      recursive: opts?.recursive,
    })
    this.emitLog({ type: 'kernel.instance.terminated', at: Date.now(), agentId })
  }

  /**
   * 中断指定 agent 的当前轮（仅暂停，不销毁；消息闭合后可恢复）。
   * 销毁权复用：仅祖先或 user0 可中断。
   */
  async interruptAgent(agentId: string, opts?: { by?: string }): Promise<void> {
    const by = makeAgentID(opts?.by ?? USER_ID)
    const target = makeAgentID(agentId)
    if (by !== makeAgentID(USER_ID) && !this.lineage.isAncestorOf(by, target)) {
      throw { kind: 'agent_terminate_denied', agentId: target, by: by as string }
    }
    this.runtime.abort(target)
  }

  /** 中断所有活跃 agent（进程优雅收尾用）。 */
  abortAllAgents(): void {
    this.runtime.abortAll()
  }

  /** 当前活跃（thinking/进行中）的 agent id 列表。 */
  activeAgents(): readonly AgentID[] {
    return this.runtime.activeAgents()
  }

  /** Scheduler 最小直通：空间内已存在该模板实例则复用，否则创建。 */
  async getOrCreateAgent(
    className: AgentClassID,
    project: ProjectRef,
    opts?: { userPrompt?: string },
  ): Promise<AgentID> {
    const space = await this.spaces.getOrCreate(project)
    const existing = await this.instances.listBySpace(space.id)
    const found = existing.find((agent) => agent.classRef === className)
    if (found) return found.id
    return this.instantiateAgent(
      {
        className,
        parentId: makeAgentID(USER_ID),
        userPrompt: opts?.userPrompt ?? '你好，请做一个简短的自我介绍。',
      },
      project,
    )
  }

  /** 空间内实例列表。 */
  async listAgentsBySpace(spaceId: AgentSpaceID): Promise<AgentID[]> {
    const agents = await this.instances.listBySpace(spaceId)
    return agents.map((agent) => agent.id)
  }

  /**
   * 导出某 agent 的完整上下文（jsonl）。薄转发到 context 模块（纯格式化）。
   * 供宿主调试/审计；作为系统工具时由 Kernel 做权限校验（agent 只能看自己的）。
   */
  async exportContext(agentId: string): Promise<string> {
    return this.contextManager.exportJsonl(agentId)
  }

  /**
   * 上下文概览（只读反射）。薄转发到 context 模块（纯格式化）。
   * 通用能力，不依赖任何特定上下文策略。
   */
  async contextOverview(agentId: string): Promise<string> {
    return this.contextManager.overview(agentId)
  }

  /** 参与者列表（复用实例 + user0，无独立注册表）。 */
  async listParticipants(): Promise<string[]> {
    const spaces = await this.spaces.list()
    const ids: string[] = [USER_ID]
    for (const space of spaces) {
      const agents = await this.instances.listBySpace(space.id)
      ids.push(...agents.map((a) => a.id))
    }
    return ids
  }

  private handleDelivery(delivery: MailDelivery): void {
    if (delivery.kind === 'agent') {
      void this.runtime.processDelivery(delivery)
    }
  }

  /** 注册新 agent 类（供系统工具 agent_class_create 使用，含日志）。 */
  async registerAgentClass(cls: AgentClass): Promise<void> {
    await this.templates.register(cls)
    this.emitLog({ type: 'kernel.class.registered', at: Date.now(), classId: cls.name })
  }

  /** 发送日志事件（直接写入日志记录器，无总线中转）。 */
  private emitLog(event: LogEvent): void {
    this.logger.log(event)
  }
}
