// ============================================================
// core/kernel/persisted.ts —— PersistedInstanceManager（写穿装饰器）
//
// 与 PersistedRepository 同构：内存为准 + write-through。
// terminate（含 recursive 级联）用"前后快照差"找出全部被删 id，
// 逐个 store.delete，杜绝级联漏删。
//
// 轮末账目走显式通道 recordTurnEnd（累加 + snap 落行）——旧「引用直改
// 等下次状态快照收敛」的已知边界已修复：实测收尾快照在循环内先于统计
// 发生，账目系统性滞后一整轮、强杀进程即丢；全字段快照仍随任何写操作收敛。
// ============================================================

import type { AgentID, AgentInstance, AgentSpace } from './types'
import type { InstanceManager, InstantiateOptions } from './InstanceManager'
import type { AgentSpaceID, ProjectRef } from './types'
import type { SpaceManager } from './SpaceManager'
import type { InstanceStore } from './store'

/** InstanceManager 装饰器：写穿 InstanceStore（内存为准）。 */
export class PersistedInstanceManager implements InstanceManager {
  constructor(
    private readonly inner: InstanceManager,
    private readonly store: InstanceStore,
  ) {}

  /** 从 store 恢复内层内存态（启动装配调用；状态归一化在 inner.restore 内）。 */
  restoreFromStore(): readonly AgentInstance[] {
    const records = this.store.loadAll()
    for (const record of records) this.inner.restore(record)
    return records
  }

  async instantiate(opts: InstantiateOptions): Promise<AgentInstance> {
    const instance = await this.inner.instantiate(opts)
    this.store.upsert(instance)
    return instance
  }

  async terminate(agentId: AgentID, opts?: { by?: AgentID; recursive?: boolean }): Promise<void> {
    const before = new Set(this.inner.listAllSync().map((a) => a.id))
    await this.inner.terminate(agentId, opts)
    for (const id of before) {
      if (!this.inner.listAllSync().some((a) => a.id === id)) this.store.delete(id)
    }
  }

  get(agentId: AgentID): Promise<AgentInstance> {
    return this.inner.get(agentId)
  }
  listBySpace(spaceId: AgentSpaceID): Promise<AgentInstance[]> {
    return this.inner.listBySpace(spaceId)
  }
  listAll(): Promise<readonly AgentInstance[]> {
    return this.inner.listAll()
  }
  getSync(agentId: AgentID): AgentInstance | undefined {
    return this.inner.getSync(agentId)
  }
  listAllSync(): readonly AgentInstance[] {
    return this.inner.listAllSync()
  }

  async updateStatus(agentId: AgentID, status: AgentInstance['status']): Promise<void> {
    await this.inner.updateStatus(agentId, status)
    this.snap(agentId)
  }

  async recordTurnEnd(agentId: AgentID, stats: { readonly turns: number; readonly cost: number }): Promise<void> {
    await this.inner.recordTurnEnd(agentId, stats)
    this.snap(agentId)
  }

  async takeover(agentId: AgentID, patch: Partial<AgentInstance>): Promise<void> {
    await this.inner.takeover(agentId, patch)
    this.snap(agentId)
  }

  async setModel(agentId: AgentID, model: NonNullable<AgentInstance['model']>): Promise<void> {
    await this.inner.setModel(agentId, model)
    // R14：模型显式层随实例行落盘（行 JSON 序列化，零 schema 迁移）。
    this.snap(agentId)
  }

  async setModelSnapshot(agentId: AgentID, snapshot: NonNullable<AgentInstance['modelSnapshot']>): Promise<void> {
    await this.inner.setModelSnapshot(agentId, snapshot)
    // §5 族规持久载体：出生快照随实例行落盘（replay 优先于父现值）。
    this.snap(agentId)
  }

  restore(instance: AgentInstance): void {
    this.inner.restore(instance)
  }

  private snap(agentId: AgentID): void {
    const current = this.inner.getSync(agentId)
    if (current) this.store.upsert(current)
  }
}

/** SpaceManager 装饰器：空间行 write-through（实例 spaceId 重启后可解析）。 */
export class PersistedSpaceManager implements SpaceManager {
  constructor(
    private readonly inner: SpaceManager,
    private readonly store: InstanceStore,
  ) {}

  /** 从 store 恢复空间（启动装配调用）。 */
  restoreFromStore(): void {
    for (const space of this.store.loadSpaces()) this.inner.restore(space)
  }

  async getOrCreate(project: ProjectRef): Promise<AgentSpace> {
    const space = await this.inner.getOrCreate(project)
    this.store.upsertSpace(space)
    return space
  }

  get(spaceId: AgentSpaceID): Promise<AgentSpace> {
    return this.inner.get(spaceId)
  }
  list(): Promise<AgentSpace[]> {
    return this.inner.list()
  }

  async remove(spaceId: AgentSpaceID): Promise<void> {
    await this.inner.remove(spaceId)
    this.store.deleteSpace(spaceId)
  }

  restore(space: AgentSpace): void {
    this.inner.restore(space)
  }
}
