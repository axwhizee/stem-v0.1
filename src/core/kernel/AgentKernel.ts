// ============================================================
// core/kernel/AgentKernel.ts —— Kernel 组合根（core 内部装配）
//
// 装配：模板注册表 / 实例管理 / 空间 / 总线 / 邮局（上下文管理器）
//      / 运行时 / 工具注册表。
// 职责：
//   - instantiateAgent：实例化 + 注册总线 + 注册邮局 + 投递首信
//   - registerUser：用户面板（user0）注册总线 + 邮局
//   - sendUserMessage：用户消息入口
//   - registerSystemTools：系统管理工具（agent_*/bus_*）
//   - 工具 onRecord → 邮局（工具自动记录，不依赖 runtime）
// ============================================================

import type { ModelGateway } from '../gateway'
import type { LLMEvent, ModelRef, UsageEvent } from '../gateway'
import { DefaultMessageBus } from '../bus'
import type { MessageBus } from '../bus'
import type { ContextAssembler, ContextManager, MailDelivery, UserDelivery } from '../context'
import { DefaultContextManager } from '../context'
import type { Logger } from '../logging'
import { InMemoryLogger } from '../logging'
import type { LogEvent } from '../logging'
import type { PermissionManager } from '../permission'
import { DefaultPermissionManager } from '../permission'
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

/** 用户面板固定 id（与 agent 在总线/邮局中一视同仁）。 */
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
  /** 日志记录器（缺省内存版；组合根把各模块日志经 bus 路由到这里）。 */
  readonly logger?: Logger
  /** 面板消息消费者（shell/GUI 注入；统一消费回信/权限请求等面板消息）。 */
  readonly onPanelMessage?: PanelConsumer
}

export class AgentKernel {
  readonly templates: AgentTemplateRegistry
  readonly instances: AgentInstanceManager
  readonly spaces: AgentSpaceManager
  readonly bus: MessageBus
  readonly contextManager: ContextManager
  readonly runtime: AgentRuntime
  readonly tools?: ToolCapabilityRegistry
  /** 权限管理器（registry 统一确认；ask 挂起经 PanelBus 交面板）。 */
  readonly permissions: PermissionManager
  /** 面板消息总线（core → 面板统一通道）。 */
  readonly panel: PanelBus
  /** 日志记录器（MessageBus log 路由的订阅者）。 */
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
    })

    this.contextManager = new DefaultContextManager({
      contextAssembler: options.contextAssembler,
      defaultCountdownMs: options.defaultCountdownMs,
      timer: options.timer,
      onLog: (event) => this.emitLog(event),
    })

    // 总线路由：agent 消息 → 邮局；log → 日志；permission_reply → 权限管理器。
    this.bus = new DefaultMessageBus({
      forward: (msg) => {
        this.emitLog({
          type: 'kernel.message.sent',
          at: msg.at,
          from: msg.from,
          to: msg.to,
          kind: msg.kind,
          payloadSize: msg.payload.length,
        })
        return this.contextManager.deposit(msg.to, { role: 'user', content: msg.payload }, msg.from)
      },
      onLog: (event) => this.logger.log(event),
      onPermissionReply: (reply) => void this.permissions.reply(reply),
    })

    this.runtime = new DefaultAgentRuntime({
      gateway: options.gateway,
      instances: this.instances,
      templates: this.templates,
      contextManager: this.contextManager,
      bus: this.bus,
      tools: options.tools,
      defaultModel: options.defaultModel,
      maxSteps: options.maxSteps,
      estimateCost: options.estimateCost,
      onEvent: options.onEvent,
      onLog: { log: (event) => this.emitLog(event) },
    })

    // 工具自动记录 → 邮局（触发/成功/失败），不依赖 runtime 手动发送。
    // context_wait 工具无常规 tool 结果（结果由邮局在等待对象回信时填充）。
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
    // 工具调用日志 → bus；权限确认 → PermissionManager。
    this.tools?.setLogSink?.({ log: (event) => this.emitLog(event) })
    this.tools?.setPermissionSink?.(this.permissions)
  }

  /** 注册用户面板（user0）到总线 + 邮局（不组装，只汇总信件）。 */
  async registerUser(displayName = 'User'): Promise<void> {
    await this.bus.register({ id: USER_ID, kind: 'user', displayName })
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
    await this.bus.send({ kind: 'user_prompt', from: USER_ID, to: agentId, payload: text, at: Date.now() })
  }

  /** 实例化：创建实例 + 注册总线 + 注册邮局(systemPrompt + 倒计时 + 送信回调) + 投递首信。 */
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

    await this.bus.register({ id: instance.id, kind: 'agent', displayName: instance.displayName })

    const template = await this.templates.get(instance.classRef)
    await this.contextManager.register({
      agentId: instance.id,
      systemPrompt: template.systemPrompt,
      sendCountdownMs: template.sendCountdown,
      assemble: true,
      onDelivery: (delivery) => this.handleDelivery(delivery),
      onHold: (id) => void this.runtime.notifyHold(makeAgentID(id)),
    })

    // userPrompt 作为首封信投递（邮局驱动，不 hold 等待）。
    await this.contextManager.deposit(instance.id, { role: 'user', content: instance.userPrompt })
    return instance.id
  }

  /** 注册系统管理工具（agent_ 与 bus_ 前缀）到工具注册表。 */
  async registerSystemTools(registry: ToolCapabilityRegistry): Promise<void> {
    for (const tool of createSystemTools(this)) {
      await registry.register(tool)
    }
  }

  /** 终止实例：注销邮局 + 总线 + 实例。 */
  async terminateAgent(agentId: string): Promise<void> {
    await this.contextManager.unregister(agentId)
    await this.bus.unregister(agentId)
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

  /** 发送日志事件（经消息总线 → 日志记录器）。 */
  private emitLog(event: LogEvent): void {
    void this.bus.send({ kind: 'log', event, at: Date.now() })
  }
}
