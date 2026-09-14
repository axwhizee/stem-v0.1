// ============================================================
// test/support/memoryInstanceStore.ts —— InstanceStore 的内存测试替身
//
// 唯一消费者是持久化装饰器（PersistedInstanceManager）的行为测试：
// 当 spy 用（断言行写入/删除/恢复）。生产壳的实例持久化 =
// SQLite（shell/cli/storage）；core 不内置内存实现。
// ============================================================

import type { InstanceStore } from '../../src/core/kernel'
import type { AgentID, AgentInstance } from '../../src/core/kernel/types'

export class MemoryInstanceStore implements InstanceStore {
  private readonly rows = new Map<string, AgentInstance>()

  upsert(instance: AgentInstance): void {
    this.rows.set(instance.id, { ...instance })
  }

  delete(agentId: AgentID): void {
    this.rows.delete(agentId)
  }

  loadAll(): readonly AgentInstance[] {
    return [...this.rows.values()].map((r) => ({ ...r }))
  }
}
