// ============================================================
// core/kernel/store.ts —— 实例持久化端口（InstanceStore）
//
// 族谱个体的持久化抽象（与 context 层 MessageStore 分离，
// 驱动层如 SQLite 同时实现两端口）。同步接口。
// 默认实现 MemoryInstanceStore（内存参考实现）。
// ============================================================

import type { AgentID, AgentInstance, AgentSpace } from './types'

/**
 * 内核态持久化端口（个体层环境：实例 + 空间）。
 * 空间随实例一并持久化——重启后 spaceId 必须可解析（listAgents 按空间遍历）。
 */
export interface InstanceStore {
  /** 落一行（INSERT OR UPDATE by id；状态/成本/displayName 全字段快照）。 */
  readonly upsert: (instance: AgentInstance) => void
  /** 物理删除实例行（terminate 语义：个体消亡，消息走 MessageStore 归档）。 */
  readonly delete: (agentId: AgentID) => void
  /** 加载全部实例行（恢复用）。 */
  readonly loadAll: () => readonly AgentInstance[]
  /** 空间行 write-through（getOrCreate/remove）。 */
  readonly upsertSpace: (space: AgentSpace) => void
  readonly deleteSpace: (spaceId: AgentSpace['id']) => void
  /** 加载全部空间（恢复用）。 */
  readonly loadSpaces: () => readonly AgentSpace[]
  /** 释放资源（可选）。 */
  readonly close?: () => void
}

/** 内存参考实现。 */
export class MemoryInstanceStore implements InstanceStore {
  private readonly rows = new Map<string, AgentInstance>()
  private readonly spaces = new Map<string, AgentSpace>()

  upsert(instance: AgentInstance): void {
    this.rows.set(instance.id, { ...instance })
  }

  delete(agentId: AgentID): void {
    this.rows.delete(agentId)
  }

  loadAll(): readonly AgentInstance[] {
    return [...this.rows.values()].map((r) => ({ ...r }))
  }

  upsertSpace(space: AgentSpace): void {
    this.spaces.set(space.id, { ...space })
  }

  deleteSpace(spaceId: AgentSpace['id']): void {
    this.spaces.delete(spaceId)
  }

  loadSpaces(): readonly AgentSpace[] {
    return [...this.spaces.values()].map((s) => ({ ...s }))
  }
}
