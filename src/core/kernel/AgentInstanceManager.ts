// ============================================================
// core/kernel/AgentInstanceManager.ts —— 实例管理器
//
// 实例化必填：classId + userPrompt + creatorId（用户默认 'user0'）。
// id 可显式指定（冲突报错），默认随机 4 位 hash。
// 总线/邮局注册由 AgentKernel 在实例化流程中完成。
// ============================================================

import type { AgentTemplateRegistry } from './AgentTemplateRegistry'
import type { AgentClassID, AgentID, AgentInstance, AgentInstancePatch, AgentSpaceID, AgentStatus } from './types'
import { makeAgentID } from './types'

export interface InstantiateOptions {
  readonly classId: AgentClassID
  /** 创建者 id（用户 'user0'；agent 为其 id）。 */
  readonly creatorId: string
  /** 实例化必填的 user prompt（首封信）。 */
  readonly userPrompt: string
  readonly spaceId: AgentSpaceID
  readonly displayName?: string
  /** 显式指定 id（与现有实例冲突时报错）。 */
  readonly id?: string
}

export interface AgentInstanceManager {
  readonly instantiate: (opts: InstantiateOptions) => Promise<AgentInstance>
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

  async instantiate(opts: InstantiateOptions): Promise<AgentInstance> {
    // 校验模板存在。
    const template = await this.registry.get(opts.classId)
    if (!opts.userPrompt || typeof opts.userPrompt !== 'string') {
      throw { kind: 'agent_conflict', message: 'userPrompt 是必填项（保证 messages 至少 [system, user]）' }
    }
    if (!opts.creatorId) {
      throw { kind: 'agent_conflict', message: 'creatorId 是必填项' }
    }

    const id = opts.id !== undefined ? makeAgentID(opts.id) : this.generateId()
    if (this.agents.has(id)) {
      throw { kind: 'agent_conflict', message: `agent id 冲突: ${id}` }
    }

    const instance: AgentInstance = {
      id,
      classRef: template.id,
      creatorId: opts.creatorId,
      displayName: opts.displayName ?? template.name,
      createdBy: opts.creatorId === 'user0' ? 'user' : (opts.creatorId as AgentID),
      spaceId: opts.spaceId,
      status: 'idle',
      turnCount: 0,
      totalCost: 0,
      userPrompt: opts.userPrompt,
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

  private generateId(): AgentID {
    for (let attempt = 0; attempt < 20; attempt++) {
      const id = Math.random().toString(36).slice(2, 6).padStart(4, '0')
      if (!this.agents.has(id as AgentID)) return id as AgentID
    }
    throw { kind: 'agent_conflict', message: '无法生成唯一 agent id' }
  }
}
