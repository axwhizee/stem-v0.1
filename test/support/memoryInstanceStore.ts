// ============================================================
// test/support/memoryInstanceStore.ts —— InstanceStore 的内存测试替身
//
// 唯一消费者是持久化装饰器（PersistedInstanceManager/PersistedSpaceManager）
// 的行为测试：当 spy 用（断言行写入/删除/恢复）。生产壳的实例持久化 =
// SQLite（shell/cli/storage）；core 不内置内存实现（DefaultInstanceManager
// 自带 Map 即纯内存路径，无需第二形制）。
// ============================================================

import type { InstanceStore } from '../../src/core/kernel'
import type {
  AgentID,
  AgentInstance,
  AgentSpace,
} from '../../src/core/kernel/types'

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
