// ============================================================
// core/pilot/Pilot.ts —— 根（user#0）扮演接口（Pilot）
//
// 外部（shell/webui）与自治系统的核心交互 = 扮演根（user 类普通实例，id `0`）。
// Pilot 是根的「驾驶舱」：
//   - 扮演层：以根身份行动（发消息/实例化/终止/中断/回复访问申请/
//     上下文管理）——即根的 action，与 agent 经工具调用等同；
//   - 观察层：经 SystemFacade 直接读（列表/详情/活跃/上下文概览）。
// 事件流统一经 subscribe 订阅（PilotEvent：stream/letter/status/notice）。
// **门面化（D4）**：pilot 只依赖 SystemFacade 接口，不依赖具体 Kernel；
// 实现由组合根注入。identity 字段支持未来 as(agentId) 扮演任意 agent（当前恒为根）。
// ============================================================

import type { AgentID, AgentInstance, ProjectRef, SystemFacade } from '../kernel'
import { makeAgentClassID, makeAgentID, ROOT_ID } from '../kernel'
import type { PilotEvent } from '../events'
import type { AccessReplyInput, ToolAccess } from '../tools'
import type { ModelRef } from '../gateway'

export interface Pilot {
  /** 扮演身份（当前恒为根 user#0；未来 as(agentId) 可扮演任意 agent）。 */
  readonly identity: AgentID
  /** 订阅统一事件流（PilotEvent：stream/letter/status/notice）。 */
  readonly subscribe: (listener: (event: PilotEvent) => void) => () => void
  /** 以根身份向目标 agent 发消息（根收信统一经事件流 letter 送达）。 */
  readonly sendMessage: (to: string, text: string) => Promise<void>
  /** 以根身份实例化 agent（parentId=根；name 可选，缺省派生 `类名-N`）。 */
  readonly instantiate: (
    opts: {
      className: string
      userPrompt: string
      /** 出生称呼（缺省确定性推导 `类名-N`；撞全局名被拒）。 */
      name?: string
      /** 显式模型（出生链最高层；"提供商/模型" 由调用侧解析）。 */
      model?: ModelRef
      contextRefs?: readonly string[]
      tools?: Readonly<Record<string, ToolAccess>>
    },
    project: ProjectRef,
  ) => Promise<AgentID>
  /**
   * 以根身份切换 agent 运行时模型（扮演层通道；agent_update 工具的同权入口，
   * 宿主 webui/CLI 直连）。不级联子孙、随实例行持久。
   */
  readonly setModel: (agentId: string, model: ModelRef) => Promise<void>
  /** 终止 agent（by=根；根无祖先故根不可被销毁）。 */
  readonly terminate: (agentId: string, opts?: { recursive?: boolean }) => Promise<void>
  /** 中断 agent 当前轮（仅暂停，可恢复）。 */
  readonly interrupt: (agentId: string) => Promise<void>
  /** 回复访问申请（access_reply 的扮演层入口；by=根答复授权）。 */
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
  /** 系统门面（组合根注入；pilot 唯一依赖面）。 */
  readonly facade: SystemFacade
  /** 扮演身份（缺省根 `0`）。 */
  readonly identity?: AgentID
}

export class DefaultPilot implements Pilot {
  readonly identity: AgentID
  private readonly facade: SystemFacade

  constructor(options: PilotOptions) {
    this.facade = options.facade
    this.identity = options.identity ?? ROOT_ID
  }

  subscribe(listener: (event: PilotEvent) => void): () => void {
    return this.facade.subscribe(listener)
  }

  async sendMessage(to: string, text: string): Promise<void> {
    // 根的完整 transcript：人类（扮演根）的输出记录为根的 assistant 消息；
    // 同一文本作为 user 消息投递给目标 agent（from=根）。
    await this.facade.appendHistory(this.identity, { role: 'assistant', content: text })
    await this.facade.sendUserMessage(to, text)
  }

  async instantiate(
    opts: {
      className: string
      userPrompt: string
      name?: string
      model?: ModelRef
      contextRefs?: readonly string[]
      tools?: Readonly<Record<string, ToolAccess>>
    },
    project: ProjectRef,
  ): Promise<AgentID> {
    const spaceId = await this.facade.getOrCreateSpace(project)
    return this.facade.instantiate(
      {
        className: makeAgentClassID(opts.className),
        parentId: this.identity,
        userPrompt: opts.userPrompt,
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        contextRefs: opts.contextRefs,
        tools: opts.tools,
        ...(opts.model !== undefined ? { model: opts.model } : {}),
      },
      spaceId,
    )
  }

  async setModel(agentId: string, model: ModelRef): Promise<void> {
    // 根 = 族谱全体祖先，可见域天然覆盖；by 记审计归属。
    await this.facade.setAgentModel(agentId, model, { by: this.identity })
  }

  async terminate(agentId: string, opts?: { recursive?: boolean }): Promise<void> {
    await this.facade.terminateAgent(agentId, { by: this.identity, recursive: opts?.recursive })
  }

  async interrupt(agentId: string): Promise<void> {
    await this.facade.interruptAgent(agentId, { by: this.identity })
  }

  async replyAccess(input: AccessReplyInput): Promise<void> {
    await this.facade.replyAccess(input, this.identity)
  }

  async listAgents(spaceId?: string): Promise<AgentInstance[]> {
    if (spaceId !== undefined) {
      return [...(await this.facade.listInstancesInSpace(spaceId))]
    }
    const spaces = await this.facade.listSpaces()
    const result: AgentInstance[] = []
    for (const space of spaces) {
      result.push(...(await this.facade.listInstancesInSpace(space.id)))
    }
    return result
  }

  async inspect(agentId: string): Promise<AgentInstance> {
    return this.facade.getInstance(makeAgentID(agentId))
  }

  activeAgents(): readonly AgentID[] {
    return this.facade.activeAgents()
  }

  async contextOverview(agentId: string): Promise<string> {
    return this.facade.contextOverview(agentId)
  }

  async exportContext(agentId: string): Promise<string> {
    return this.facade.exportContext(agentId)
  }

  async runContextAction(agentId: string, action: string, args?: string): Promise<string> {
    // user#0 = 族谱根（全体祖先）：策略动作授权校验天然通过。
    return this.facade.runStrategyAction(agentId, action, args)
  }
}

/** 构造 Pilot：pilot 初始化流程内自动实例化 user#0（user 类，普通实例，parentId=null）。 */
export async function createPilot(options: PilotOptions): Promise<Pilot> {
  const identity = options.identity ?? ROOT_ID
  if (!options.facade.getInstanceSync(identity)) {
    await options.facade.registerRootAgent()
  } else {
    // 重启恢复路径：config.user.name = 真相，对齐存量根（配置面改动跨重启生效）。
    await options.facade.alignRootName()
  }
  return new DefaultPilot({ ...options, identity })
}
