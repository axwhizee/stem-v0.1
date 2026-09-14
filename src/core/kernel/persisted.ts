// ============================================================
// core/kernel/persisted.ts —— PersistedInstanceManager（写穿装饰器）
//
// 与 PersistedRepository 同构：内存为准 + write-through。
// terminate（含 recursive 级联）用"前后快照差"找出全部被销 id，逐个
// **落墓碑行**（status='terminated'）而非物理删——地址与称呼的占用是
// 持久事实（序号永不回收，重启 restore 扫描含墓碑立计数器地板）。
// 行归档清理（真 DELETE）是宿主法医面（dashboard）的专属，不属出生机制。
//
// 轮末账目走显式通道 recordTurnEnd（累加 + snap 落行）——旧「引用直改
// 等下次状态快照收敛」的已知边界已修复：实测收尾快照在循环内先于统计
// 发生，账目系统性滞后一整轮、强杀进程即丢；全字段快照仍随任何写操作收敛。
// ============================================================

import type { AgentID, AgentInstance, AgentInstancePatch, ModelBinding } from './types'
import type { InstanceManager, InstantiateOptions, ResolveResult } from './InstanceManager'
import type { InstanceStore } from './store'

/** InstanceManager 装饰器：写穿 InstanceStore（内存为准）。 */
export class PersistedInstanceManager implements InstanceManager {
  constructor(
    private readonly inner: InstanceManager,
    private readonly store: InstanceStore,
  ) {}

  /** 从 store 恢复内层内存态（启动装配调用；状态归一化/墓碑占用在 inner.restore 内）。
   *  返回值 = 活体行（墓碑只立占用，不进 kernel 恢复接线名单）。
   *  装载期唯一性校验（B2）：全行集（含墓碑）出现重复 name = 文件真相被手改
   *  → boot 硬错（拒载，修文件即可）。 */
  restoreFromStore(): readonly AgentInstance[] {
    const records = this.store.loadAll()
    const dup = this.inner.assertNamesUnique(records)
    if (dup.length > 0) {
      throw {
        kind: 'agent_name_conflict',
        name: dup[0] ?? '',
        message: `装载期称呼唯一性校验失败（DB 实例行重复 name: ${dup.join(', ')}）——文件真相被手改？修正实例行或删「.stem/stem.db」重建空间`,
      }
    }
    for (const record of records) this.inner.restore(record)
    return records.filter((r) => r.status !== 'terminated')
  }

  async instantiate(opts: InstantiateOptions): Promise<AgentInstance> {
    const instance = await this.inner.instantiate(opts)
    this.store.upsert(instance)
    return instance
  }

  async terminate(agentId: AgentID, opts?: { by?: AgentID; recursive?: boolean }): Promise<void> {
    // 前快照留存被销行的最后形态（含级联子树），terminate 后逐个落墓碑行。
    const before = new Map(this.inner.listAllSync().map((a) => [a.id, a]))
    await this.inner.terminate(agentId, opts)
    for (const [id, instance] of before) {
      if (!this.inner.listAllSync().some((a) => a.id === id)) this.store.upsert({ ...instance, status: 'terminated' })
    }
  }

  get(agentId: AgentID): Promise<AgentInstance> {
    return this.inner.get(agentId)
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

  async recordTurnEnd(agentId: AgentID, stats: { readonly turns: number; readonly cost: number; readonly tokens: number }): Promise<void> {
    await this.inner.recordTurnEnd(agentId, stats)
    this.snap(agentId)
  }

  async update(agentId: AgentID, patch: Partial<AgentInstancePatch>): Promise<void> {
    await this.inner.update(agentId, patch)
    // 参数三件（name/toolOverride/model 显式层）全随实例行落盘。
    this.snap(agentId)
  }

  async setModelBinding(agentId: AgentID, binding: ModelBinding): Promise<void> {
    await this.inner.setModelBinding(agentId, binding)
    this.snap(agentId)
  }

  async setCtxTokens(agentId: AgentID, tokens: number): Promise<void> {
    await this.inner.setCtxTokens(agentId, tokens)
    this.snap(agentId)
  }

  restore(instance: AgentInstance): void {
    this.inner.restore(instance)
  }

  resolve(ref: string): ResolveResult {
    return this.inner.resolve(ref)
  }

  displayOf(agentId: string): string {
    return this.inner.displayOf(agentId)
  }

  assertNamesUnique(records: readonly AgentInstance[]): string[] {
    return this.inner.assertNamesUnique(records)
  }

  private snap(agentId: AgentID): void {
    const current = this.inner.getSync(agentId)
    if (current) this.store.upsert(current)
  }
}
