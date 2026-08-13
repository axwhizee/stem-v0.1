// ============================================================
// core/kernel/AgentKernel.ts —— Kernel 组合根（core 内部装配）
//
// 装配：模板注册表 / 实例管理 / 空间 / 上下文仓库 + 管理员 + 快递员
//      / 运行时 / 工具注册表。
//
// 通信模型（重建邮局，无总线）：
//   - sendMessage(from, to, payload) → 管理员 deposit（打戳 + 入库 + 触发处理）；
//   - log / permission_reply 走注入接口（LogSink / PermissionManager），不设总线。
// 参与者查询：复用 instances + user0（无独立注册表）。
// ============================================================

import type { ModelGateway } from '../gateway'
import type { LLMEvent, ModelRef, UsageEvent } from '../gateway'
import type { ContextAssembler, MailDelivery, Repository, Courier, UserDelivery } from '../context'
import { DefaultRepository, DefaultCourier, DefaultContextManager } from '../context'
import type { ContextManager } from '../context'
import type { Logger } from '../logging'
import { InMemoryLogger } from '../logging'
import type { LogEvent } from '../logging'
import type { PermissionManager } from '../permission'
import { DefaultPermissionManager } from '../permission'
import type { PermissionAction } from '../permission'
import { permissionsToRules } from '../permission'
import type { PanelConsumer } from '../panel'
import { DefaultPanelBus } from '../panel'
import type { PanelBus } from '../panel'
import type { ToolCapabilityRegistry, ToolContext } from '../tools'
import simpleChatTemplate from '../../../templates/SimpleChat.json'
import coderTemplate from '../../../templates/Coder.json'
import { DefaultAgentTemplateRegistry } from './AgentTemplateRegistry'
import type { AgentTemplateRegistry } from './AgentTemplateRegistry'
import { DefaultAgentInstanceManager } from './AgentInstanceManager'
import type { AgentInstanceManager, InstantiateOptions } from './AgentInstanceManager'
import { DefaultAgentSpaceManager } from './AgentSpaceManager'
import type { AgentSpaceManager } from './AgentSpaceManager'
import { DefaultAgentRuntime } from './AgentRuntime'
import type { AgentRuntime } from './AgentRuntime'
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

export interface AgentKernelOptions {
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
  /** 流式事件全局透传。 */
  readonly onEvent?: (agentId: AgentID, event: LLMEvent) => void
  /** 用户面板收信回调（user0 信箱送信时调用）。 */
  readonly onUserDelivery?: (delivery: UserDelivery) => void
  /** 日志记录器（缺省内存版）。 */
  readonly logger?: Logger
  /** 面板消息消费者（shell/GUI 注入；统一消费回信/权限请求等面板消息）。 */
  readonly onPanelMessage?: PanelConsumer
  /**
   * 全局默认权限（来自配置 `permission`，最弱优先级）。
   * 评估顺序：[全局默认, agent 类规则, session 批准]，最后命中优先。
   */
  readonly globalPermissionDefaults?: Readonly<Record<string, PermissionAction>>
  /** 权限自动批准（来自配置 `autoApprove`）：ask 直接放行，不弹窗。 */
  readonly autoApprove?: boolean
}

export class AgentKernel {
  readonly templates: AgentTemplateRegistry
  readonly instances: AgentInstanceManager
  readonly spaces: AgentSpaceManager
  /** 上下文仓库（上下文本体的唯一存储）。 */
  readonly repository: Repository
  /** 上下文管理员（处理/打戳/组装）。 */
  readonly contextManager: ContextManager
  /** 快递员（倒计时 + 发送）。 */
  readonly courier: Courier
  readonly runtime: AgentRuntime
  readonly tools?: ToolCapabilityRegistry
  /** 权限管理器（registry 统一确认；ask 挂起经 PanelBus 交面板）。 */
  readonly permissions: PermissionManager
  /** 面板消息总线（core → 面板统一通道）。 */
  readonly panel: PanelBus
  /** 日志记录器。 */
  readonly logger: Logger
  private readonly userDeliveryHandler?: (delivery: UserDelivery) => void

  constructor(options: AgentKernelOptions) {
    this.userDeliveryHandler = options.onUserDelivery
    this.templates = new DefaultAgentTemplateRegistry(options.templates ?? BUILTIN_TEMPLATES)
    this.instances = new DefaultAgentInstanceManager(this.templates)
    this.spaces = new DefaultAgentSpaceManager()
    this.tools = options.tools
    this.logger = options.logger ?? new InMemoryLogger()

    // 面板消息总线（统一汇总回信/权限请求等面板消息，GUI 可完全复用）。
    this.panel = new DefaultPanelBus({ consumer: options.onPanelMessage })

    // 权限管理器：ask 挂起 → 面板弹窗；always → session 批准。
    this.permissions = new DefaultPermissionManager({
      askPanel: (request) =>
        this.panel.post({
          type: 'permission_request',
          requestId: request.id,
          permission: request.permission,
          agentId: request.agentId,
          metadata: request.metadata,
          at: request.at,
        }),
      onLog: { log: (event) => this.emitLog(event) },
      globalDefaults: options.globalPermissionDefaults
        ? permissionsToRules(options.globalPermissionDefaults)
        : undefined,
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

    this.runtime = new DefaultAgentRuntime({
      gateway: options.gateway,
      instances: this.instances,
      templates: this.templates,
      contextManager: this.contextManager,
      repository: this.repository,
      tools: options.tools,
      defaultModel: options.defaultModel,
      maxSteps: options.maxSteps,
      estimateCost: options.estimateCost,
      onEvent: options.onEvent,
      onLog: { log: (event) => this.emitLog(event) },
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
    // 工具调用日志；权限确认 → PermissionManager。
    this.tools?.setLogSink?.({ log: (event) => this.emitLog(event) })
    this.tools?.setPermissionSink?.(this.permissions)
  }

  /** 注册用户面板（user0）到上下文（不组装，只汇总信件）。 */
  async registerUser(displayName = 'User'): Promise<void> {
    await this.contextManager.register({
      agentId: USER_ID,
      assemble: false,
      onDelivery: (delivery) => {
        if (delivery.kind !== 'user') return
        this.userDeliveryHandler?.(delivery)
        // 统一面板消息：回信经 PanelBus 交给面板展示层。
        this.panel.post({
          type: 'letter',
          agentId: delivery.agentId,
          letters: delivery.letters,
          at: Date.now(),
        })
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
      creatorId: instance.creatorId,
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

    // userPrompt 作为首封信投递（from=user0，管理员打戳）。
    await this.contextManager.deposit(instance.id, { role: 'user', content: instance.userPrompt }, instance.creatorId)
    return instance.id
  }

  /** 注册系统管理工具（agent_ 与 bus_ 前缀）到工具注册表。 */
  async registerSystemTools(registry: ToolCapabilityRegistry): Promise<void> {
    for (const tool of createSystemTools(this)) {
      await registry.register(tool)
    }
  }

  /** 终止实例：注销上下文（仓库/管理员/快递员）+ 实例。 */
  async terminateAgent(agentId: string): Promise<void> {
    await this.contextManager.unregister(agentId)
    await this.instances.terminate(makeAgentID(agentId))
    this.emitLog({ type: 'kernel.instance.terminated', at: Date.now(), agentId })
  }

  /** Scheduler 最小直通：空间内已存在该模板实例则复用，否则创建。 */
  async getOrCreateAgent(
    classId: AgentClassID,
    project: ProjectRef,
    opts?: { displayName?: string; userPrompt?: string },
  ): Promise<AgentID> {
    const space = await this.spaces.getOrCreate(project)
    const existing = await this.instances.listBySpace(space.id)
    const found = existing.find((agent) => agent.classRef === classId)
    if (found) return found.id
    return this.instantiateAgent(
      {
        classId,
        creatorId: USER_ID,
        userPrompt: opts?.userPrompt ?? '你好，请做一个简短的自我介绍。',
        displayName: opts?.displayName,
      },
      project,
    )
  }

  /** 空间内实例列表。 */
  async listAgentsBySpace(spaceId: AgentSpaceID): Promise<AgentID[]> {
    const agents = await this.instances.listBySpace(spaceId)
    return agents.map((agent) => agent.id)
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
    this.emitLog({ type: 'kernel.class.registered', at: Date.now(), classId: cls.id })
  }

  /** 发送日志事件（直接写入日志记录器，无总线中转）。 */
  private emitLog(event: LogEvent): void {
    this.logger.log(event)
  }
}
