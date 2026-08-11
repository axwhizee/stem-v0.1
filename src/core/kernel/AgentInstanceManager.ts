// ============================================================
// core/kernel/AgentInstanceManager.ts —— 实例管理器
//
// 用户与调度创建的 Agent 本质相同（都是 AgentInstance），
// 用户可接管（takeover）任意实例（D7 / architecture §1.2）。
// ============================================================

import type { AgentTemplateRegistry } from './AgentTemplateRegistry'
import type { AgentClassID, AgentID, AgentInstance, AgentInstancePatch, AgentSpaceID, AgentStatus } from './types'
import { makeAgentID } from './types'

export interface InstantiateOptions {
  readonly spaceId: AgentSpaceID
  readonly displayName?: string
  readonly createdBy?: 'user' | AgentID
}

export interface AgentInstanceManager {
  readonly instantiate: (classId: AgentClassID, opts: InstantiateOptions) => Promise<AgentInstance>
  readonly terminate: (agentId: AgentID) => Promise<void>
  readonly get: (agentId: AgentID) => Promise<AgentInstance>
  readonly listBySpace: (spaceId: AgentSpaceID) => Promise<AgentInstance[]>
  readonly updateStatus: (agentId: AgentID, status: AgentStatus) => Promise<void>
  readonly takeover: (agentId: AgentID, patch: Partial<AgentInstancePatch>) => Promise<void>
}

export class DefaultAgentInstanceManager implements AgentInstanceManager {
  private readonly agents = new Map<AgentID, AgentInstance>()
  private counter = 0

  constructor(private readonly registry: AgentTemplateRegistry) {}

  async instantiate(classId: AgentClassID, opts: InstantiateOptions): Promise<AgentInstance> {
    // 校验模板存在，classRef 必须有效。
    await this.registry.get(classId)

    const id = makeAgentID(`agent-${++this.counter}`)
    const instance: AgentInstance = {
      id,
      classRef: classId,
      displayName: opts.displayName ?? classId,
      createdBy: opts.createdBy ?? 'user',
      spaceId: opts.spaceId,
      status: 'idle',
      turnCount: 0,
      totalCost: 0,
      history: [],
    }
    this.agents.set(id, instance)
    return instance
  }

  async terminate(agentId: AgentID): Promise<void> {
    await this.get(agentId)
    this.agents.delete(agentId)
  }

  async get(agentId: AgentID): Promise<AgentInstance> {
    const instance = this.agents.get(agentId)
    if (!instance) throw { kind: 'agent_not_found', agentId }
    return instance
  }

  async listBySpace(spaceId: AgentSpaceID): Promise<AgentInstance[]> {
    return [...this.agents.values()].filter((a) => a.spaceId === spaceId)
  }

  async updateStatus(agentId: AgentID, status: AgentStatus): Promise<void> {
    const instance = await this.get(agentId)
    instance.status = status
  }

  async takeover(agentId: AgentID, patch: Partial<AgentInstancePatch>): Promise<void> {
    const instance = await this.get(agentId)
    if (patch.displayName !== undefined) instance.displayName = patch.displayName
  }
}
