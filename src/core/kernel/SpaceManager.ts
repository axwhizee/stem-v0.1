// ============================================================
// core/kernel/SpaceManager.ts —— Agent 空间（最小版）
//
// 一个项目/工作区 = 一个 AgentSpace（D12）。本阶段仅维护
// space → project 映射与空间列表；实例归属由 InstanceManager
// 维护（spaceId 字段）。完整版（共享资产池）见 Task 2.1。
// ============================================================

import type { AgentSpace, AgentSpaceID, ProjectRef } from './types'
import { makeAgentSpaceID } from './types'

export interface SpaceManager {
  readonly getOrCreate: (project: ProjectRef) => Promise<AgentSpace>
  readonly get: (spaceId: AgentSpaceID) => Promise<AgentSpace>
  readonly list: () => Promise<AgentSpace[]>
  readonly remove: (spaceId: AgentSpaceID) => Promise<void>
  /** 持久化恢复专用：装载空间行并抬高 id 计数器（从 space-N 后缀解析）。 */
  readonly restore: (space: AgentSpace) => void
}

export class DefaultSpaceManager implements SpaceManager {
  private readonly spaces = new Map<AgentSpaceID, AgentSpace>()
  private counter = 0

  async getOrCreate(project: ProjectRef): Promise<AgentSpace> {
    const existing = [...this.spaces.values()].find((s) => s.project === project)
    if (existing) return existing
    const space: AgentSpace = { id: makeAgentSpaceID(`space-${++this.counter}`), project }
    this.spaces.set(space.id, space)
    return space
  }

  restore(space: AgentSpace): void {
    const m = /^space-(\d+)$/.exec(space.id)
    if (m?.[1] !== undefined) this.counter = Math.max(this.counter, Number(m[1]))
    if (this.spaces.has(space.id)) return
    this.spaces.set(space.id, space)
  }

  async get(spaceId: AgentSpaceID): Promise<AgentSpace> {
    const space = this.spaces.get(spaceId)
    if (!space) throw { kind: 'space_not_found', spaceId }
    return space
  }

  async list(): Promise<AgentSpace[]> {
    return [...this.spaces.values()]
  }

  async remove(spaceId: AgentSpaceID): Promise<void> {
    await this.get(spaceId)
    this.spaces.delete(spaceId)
  }
}
