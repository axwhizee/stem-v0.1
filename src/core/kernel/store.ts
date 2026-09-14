// ============================================================
// core/kernel/store.ts —— 实例持久化端口（InstanceStore）
//
// 族谱个体的持久化抽象（与 context 层 MessageStore 分离，
// 驱动层如 SQLite 同时实现两端口）。同步接口。
// 本文件只承载端口形状：core 纯内存路径 = DefaultInstanceManager 自带 Map，
// 不内置第二形制实现（内存替身住 test/support，仅供持久化装饰器测试）。
// ============================================================

import type { AgentInstance } from './types'
import type { AgentID } from './types'

/**
 * 内核态持久化端口（个体层环境：实例行；单空间无 spaces 表）。
 */
export interface InstanceStore {
  /** 落一行（INSERT OR UPDATE by id；状态/成本/name 全字段快照——含墓碑行 upsert）。 */
  readonly upsert: (instance: AgentInstance) => void
  /**
   * 物理删除实例行。**terminate 不走此口**（销毁 = 落 status='terminated' 墓碑行，
   * 地址与称呼占用是持久事实）；此口专供宿主法医面（dashboard 清理）归档真删。
   */
  readonly delete: (agentId: AgentID) => void
  /** 加载全部实例行（恢复用；含墓碑——restore 内层立占用）。 */
  readonly loadAll: () => readonly AgentInstance[]
  /** 释放资源（可选）。 */
  readonly close?: () => void
}
