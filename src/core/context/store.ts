// ============================================================
// core/context/store.ts —— 消息持久化端口（MessageStore）
//
// 个体消息的持久化抽象（同步接口，node:sqlite DatabaseSync 天然契合）：
//   - 写路径：write-through（内存为准，DB 为影，追加/改写即落行）；
//   - 恢复路径：loadBoxes 取未归档箱（插入序），maxMessageSeq 供 id 防撞。
// 归档语义：agent 销毁时消息行不物理删除（进化语料保留），仅标记 archived。
// 默认实现 MemoryMessageStore（内存参考实现，测试可直接观测持久化效果）。
// ============================================================

import type { StoredMessage } from './types'

/** 恢复单元：某 agent 的消息箱（未归档行，按插入序）。 */
export interface RestoredBox {
  readonly agentId: string
  readonly messages: readonly StoredMessage[]
}

/** 消息持久化端口（同步，宿主注入实现如 SQLite）。 */
export interface MessageStore {
  /** 落一行（INSERT OR UPDATE by id）。 */
  readonly upsert: (message: StoredMessage) => void
  /** 归档某 agent 全部消息行（销毁语义：不物理删除）。 */
  readonly archiveAgent: (agentId: string) => void
  /** 加载未归档消息箱（恢复用；按插入序）。 */
  readonly loadBoxes: () => readonly RestoredBox[]
  /** 历史最大消息序号（含归档行，恢复后 id 计数器下限，防撞）。 */
  readonly maxMessageSeq: () => number
  /** 释放资源（可选；如关闭 DB 句柄）。 */
  readonly close?: () => void
}

/** 消息 id → 序号（`m-N` 的 N；非规范 id 计 0）。 */
export function messageSeqOf(id: string): number {
  const m = /^m-(\d+)$/.exec(id)
  return m?.[1] !== undefined ? Number(m[1]) : 0
}

/** 内存参考实现（与 SQLite 适配同一语义）。 */
export class MemoryMessageStore implements MessageStore {
  private readonly rows = new Map<string, { stored: StoredMessage; archived: boolean }>()

  upsert(message: StoredMessage): void {
    const prev = this.rows.get(message.id)
    this.rows.set(message.id, { stored: message, archived: prev?.archived ?? false })
  }

  archiveAgent(agentId: string): void {
    for (const row of this.rows.values()) {
      if (row.stored.agentId === agentId) row.archived = true
    }
  }

  loadBoxes(): readonly RestoredBox[] {
    const byAgent = new Map<string, StoredMessage[]>()
    for (const row of this.rows.values()) {
      // Map 保插入序，upsert 原位覆盖 → 行序即箱内插入序。
      if (row.archived) continue
      const list = byAgent.get(row.stored.agentId)
      if (list) list.push(row.stored)
      else byAgent.set(row.stored.agentId, [row.stored])
    }
    return [...byAgent.entries()].map(([agentId, messages]) => ({ agentId, messages }))
  }

  maxMessageSeq(): number {
    let max = 0
    for (const row of this.rows.values()) {
      max = Math.max(max, messageSeqOf(row.stored.id))
    }
    return max
  }
}
