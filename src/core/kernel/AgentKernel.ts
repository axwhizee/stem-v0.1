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
import { ClassicContextAssembler, DefaultContextManager } from '../context'
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
}

export class AgentKernel {
  readonly templates: AgentTemplateRegistry
  readonly instances: AgentInstanceManager
  readonly spaces: AgentSpaceManager
  readonly bus: MessageBus
  readonly contextManager: ContextManager
  readonly runtime: AgentRuntime
  readonly tools?: ToolCapabilityRegistry
  private readonly userDeliveryHandler?: (delivery: UserDelivery) => void

  constructor(options: AgentKernelOptions) {
    this.userDeliveryHandler = options.onUserDelivery
    this.templates = new DefaultAgentTemplateRegistry(options.templates ?? BUILTIN_TEMPLATES)
    this.instances = new DefaultAgentInstanceManager(this.templates)
    this.spaces = new DefaultAgentSpaceManager()
    this.tools = options.tools

    this.contextManager = new DefaultContextManager({
      assembler: options.contextAssembler ?? new ClassicContextAssembler(),
      defaultCountdownMs: options.defaultCountdownMs,
      timer: options.timer,
    })

    // 总线转发到邮局（送信员）。
    this.bus = new DefaultMessageBus({
      forward: (msg) => this.contextManager.deposit(msg.to, { role: 'user', content: msg.payload }),
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
    })

    // 工具自动记录 → 邮局（触发/成功/失败），不依赖 runtime 手动发送。
    this.tools?.setRecordSink?.((record, ctx) => {
      void this.contextManager.appendToolRecord(ctx.agentId, record)
      if (record.status === 'success' && record.result) {
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
  }

  /** 注册用户面板（user0）到总线 + 邮局（不组装，只汇总信件）。 */
  async registerUser(displayName = 'User'): Promise<void> {
    await this.bus.register({ id: USER_ID, kind: 'user', displayName })
    await this.contextManager.register({
      agentId: USER_ID,
      assemble: false,
      onDelivery: (delivery) => {
        if (delivery.kind === 'user') this.userDeliveryHandler?.(delivery)
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
    const instance = await this.instances.instantiate({ ...opts, spaceId: space.id })

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

  /** 终止实例：注销邮局 + 总线 + 实例。 */
  async terminateAgent(agentId: string): Promise<void> {
    await this.contextManager.unregister(agentId)
    await this.bus.unregister(agentId)
    await this.instances.terminate(makeAgentID(agentId))
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
}
