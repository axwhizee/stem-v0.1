// ============================================================
// core/pilot/Pilot.ts —— user0 扮演接口（Pilot）
//
// 外部（shell/webui）与自治系统的核心交互 = 扮演 user0（元 agent）。
// Pilot 是 user0 的「驾驶舱」：
//   - 扮演层：以 user0 身份行动（发消息/实例化/终止/中断/回复访问申请/
//     上下文管理）——即 user0 的 action，与 agent 经工具调用等同；
//   - 观察层：经 kernel 直接读（列表/详情/活跃/上下文概览）。
// 事件流统一经 subscribe 订阅（PilotEvent：stream/letter/status/notice）。
// identity 字段支持未来 as(agentId) 扮演任意 agent（当前恒为 user0）。
// ============================================================

import type { Kernel } from '../kernel'
import { makeAgentClassID, makeAgentID } from '../kernel'
import type { AgentID, AgentInstance, ProjectRef } from '../kernel'
import type { PilotEvent } from '../events'
import type { AccessReplyInput, ToolAccess } from '../tools'
import type { ModelRef } from '../gateway'

export interface Pilot {
  /** 扮演身份（当前恒为 user0；未来 as(agentId) 可扮演任意 agent）。 */
  readonly identity: AgentID
  /** 订阅统一事件流（PilotEvent：stream/letter/status/notice）。 */
  readonly subscribe: (listener: (event: PilotEvent) => void) => () => void
  /** 以 user0 身份向目标 agent 发消息（user0 收信统一经事件流 letter 送达）。 */
  readonly sendMessage: (to: string, text: string) => Promise<void>
  /** 以 user0 身份实例化 agent（parentId=user0，根策略收敛起点）。 */
  readonly instantiate: (
    opts: {
      className: string
      userPrompt: string
      agentId?: string
      /** 显式模型（S6/R6 出生链最高层；"提供商/模型" 由调用侧解析）。 */
      model?: ModelRef
      contextRefs?: readonly string[]
      tools?: Readonly<Record<string, ToolAccess>>
    },
    project: ProjectRef,
  ) => Promise<AgentID>
  /**
   * 以 user0 身份切换 agent 运行时模型（S6/R7 扮演层通道；agent_set_model
   * 工具的同权入口，宿主 webui/CLI 直连）。不级联子孙、随实例行持久。
   */
  readonly setModel: (agentId: string, model: ModelRef) => Promise<void>
  /** 终止 agent（by=user0；根无祖先故 user0 不可销毁）。 */
  readonly terminate: (agentId: string, opts?: { recursive?: boolean }) => Promise<void>
  /** 中断 agent 当前轮（仅暂停，可恢复）。 */
  readonly interrupt: (agentId: string) => Promise<void>
  /** 回复访问申请（access_reply 的扮演层入口；by=user0 根授权）。 */
  readonly replyAccess: (input: AccessReplyInput) => Promise<void>
  /** 列表（可选按空间；缺省全部空间）。 */
  readonly listAgents: (spaceId?: string) => Promise<AgentInstance[]>
  /** 查看实例详情。 */
  readonly inspect: (agentId: string) => Promise<AgentInstance>
  /** 当前活跃（thinking/进行中）的 agent id 列表。 */
  readonly activeAgents: () => readonly AgentID[]
  /** 上下文概览（只读反射）。 */
  readonly contextOverview: (agentId: string) => Promise<string>
  /** 导出上下文为 jsonl（只读）。 */
  readonly exportContext: (agentId: string) => Promise<string>
  /**
   * 执行 agent 上下文策略的专有动作（如 classic 的 compact）——
   * 策略独立接口的用户通道（模型侧走 context_apply 工具）。
   */
  readonly runContextAction: (agentId: string, action: string, args?: string) => Promise<string>
}

export interface PilotOptions {
  readonly kernel: Kernel
  /** 扮演身份（缺省 user0）。 */
  readonly identity?: AgentID
}

export class DefaultPilot implements Pilot {
  readonly identity: AgentID
  private readonly kernel: Kernel

  constructor(options: PilotOptions) {
    this.kernel = options.kernel
    this.identity = options.identity ?? makeAgentID('user0')
  }

  subscribe(listener: (event: PilotEvent) => void): () => void {
    return this.kernel.events.subscribe(listener)
  }

  async sendMessage(to: string, text: string): Promise<void> {
    // user0 的完整 transcript：人类（扮演 user0）的输出记录为 user0 的 assistant 消息；
    // 同一文本作为 user 消息投递给目标 agent（from=user0）。
    await this.kernel.contextManager.appendHistory(this.identity, { role: 'assistant', content: text })
    await this.kernel.sendUserMessage(to, text)
  }

  async instantiate(
    opts: {
      className: string
      userPrompt: string
      agentId?: string
      model?: ModelRef
      contextRefs?: readonly string[]
      tools?: Readonly<Record<string, ToolAccess>>
    },
    project: ProjectRef,
  ): Promise<AgentID> {
    const space = await this.kernel.spaces.getOrCreate(project)
    return this.kernel.instantiateInSpace(
      {
        className: makeAgentClassID(opts.className),
        parentId: this.identity,
        userPrompt: opts.userPrompt,
        agentId: opts.agentId,
        contextRefs: opts.contextRefs,
        tools: opts.tools,
        ...(opts.model !== undefined ? { model: opts.model } : {}),
      },
      space.id,
    )
  }

  async setModel(agentId: string, model: ModelRef): Promise<void> {
    // user0 = 族谱根（全体祖先），可见域天然覆盖；by 记审计归属。
    await this.kernel.setAgentModel(agentId, model, { by: this.identity })
  }

  async terminate(agentId: string, opts?: { recursive?: boolean }): Promise<void> {
    await this.kernel.terminateAgent(agentId, { by: this.identity, recursive: opts?.recursive })
  }

  async interrupt(agentId: string): Promise<void> {
    await this.kernel.interruptAgent(agentId, { by: this.identity })
  }

  async replyAccess(input: AccessReplyInput): Promise<void> {
    await this.kernel.access.reply(input, this.identity)
  }

  async listAgents(spaceId?: string): Promise<AgentInstance[]> {
    if (spaceId !== undefined) {
      return this.kernel.instances.listBySpace(spaceId as never)
    }
    const spaces = await this.kernel.spaces.list()
    const result: AgentInstance[] = []
    for (const space of spaces) {
      result.push(...(await this.kernel.instances.listBySpace(space.id)))
    }
    return result
  }

  async inspect(agentId: string): Promise<AgentInstance> {
    return this.kernel.instances.get(makeAgentID(agentId))
  }

  activeAgents(): readonly AgentID[] {
    return this.kernel.activeAgents()
  }

  async contextOverview(agentId: string): Promise<string> {
    return this.kernel.contextOverview(agentId)
  }

  async exportContext(agentId: string): Promise<string> {
    return this.kernel.exportContext(agentId)
  }

  async runContextAction(agentId: string, action: string, args?: string): Promise<string> {
    // user0 = 族谱根（全体祖先）：策略动作授权校验天然通过。
    return this.kernel.contextManager.runStrategyAction(agentId, action, args)
  }
}

/** 构造 Pilot：pilot 初始化流程内自动实例化 user0（user 类，普通实例，parentId=null）。 */
export async function createPilot(options: PilotOptions): Promise<Pilot> {
  const identity = options.identity ?? makeAgentID('user0')
  if (!options.kernel.instances.getSync(identity)) {
    await options.kernel.registerRootAgent('User')
  }
  return new DefaultPilot({ ...options, identity })
}