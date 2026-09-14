// ============================================================
// shell/cli/storage/sqliteStore.ts —— SQLite 持久化适配（node:sqlite）
//
// 个体层（消息/实例）落 <projectRoot>/.stem/stem.db：实现 core 的
// MessageStore + InstanceStore 两端口（一个连接、两端口同对象暴露）。
//
// 设计选择：
//   - 行 = 记录全量 JSON（StoredMessage/AgentInstance 都是纯数据），
//     冗余 agent_id/seq 列仅供查询排序，语义转换只在 core 侧；
//   - 驱动 = node:sqlite DatabaseSync（同步，与端口契约与内存装饰器
//     write-through 语义一致；零外部依赖，node >= 23.4 免 flag）；
//   - journal 用默认 rollback（不启 WAL：WAL 依赖 shm 共享内存，
//     WSL /mnt/c 9P 挂载下有风险；原型规模 rollback 足够）；
//   - 归档：messages.archived 标记（销毁保语料，恢复不加载）；
//   - 版本守卫：PRAGMA user_version（当前 3）——**零历史兼容**（v1.0 开发期
//     特权：schema 不对就是错，拒绝加载即正确行为；无迁移脚本无兼容层，
//     明示"重建空间"出路）。
// ============================================================

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { MessageStore, RestoredBox, StoredMessage } from '../../../src/core/context'
import { messageSeqOf } from '../../../src/core/context'
import type { InstanceStore } from '../../../src/core/kernel'
import type { AgentID, AgentInstance } from '../../../src/core/kernel'

/** 当前 schema 版本（PRAGMA user_version；任何非零不符版本 = 拒载）。 */
const SCHEMA_VERSION = 3

/**
 * SQLite 个体层存储（驱动类：不直接 implements 两端口——
 * MessageStore.upsert 与 InstanceStore.upsert 同签名冲突，
 * 端口适配在 createSqliteStateStore 工厂完成）。
 */
export class SqliteStateStore {
  private readonly db: DatabaseSync
  private closed = false

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.ensureSchema()
  }

  // ---------- 消息 ----------

  upsertMessage(message: StoredMessage): void {
    this.db
      .prepare('INSERT INTO messages (id, agent_id, seq, message) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET message = excluded.message')
      .run(message.id, message.agentId, messageSeqOf(message.id), JSON.stringify(message))
  }

  archiveAgent(agentId: string): void {
    this.db.prepare('UPDATE messages SET archived = 1 WHERE agent_id = ?').run(agentId)
  }

  loadBoxes(): readonly RestoredBox[] {
    const rows = this.db
      .prepare('SELECT message FROM messages WHERE archived = 0 ORDER BY agent_id, seq')
      .all() as Array<{ message: string }>
    const byAgent = new Map<string, StoredMessage[]>()
    for (const row of rows) {
      const stored = JSON.parse(row.message) as StoredMessage
      const list = byAgent.get(stored.agentId)
      if (list) list.push(stored)
      else byAgent.set(stored.agentId, [stored])
    }
    return [...byAgent.entries()].map(([agentId, messages]) => ({ agentId, messages }))
  }

  maxMessageSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages').get() as { max_seq: number }
    return row.max_seq
  }

  // ---------- 实例 ----------

  upsertInstance(instance: AgentInstance): void {
    this.db
      .prepare('INSERT INTO instances (id, instance) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET instance = excluded.instance')
      .run(instance.id, JSON.stringify(instance))
  }

  deleteInstance(agentId: AgentID): void {
    this.db.prepare('DELETE FROM instances WHERE id = ?').run(agentId)
  }

  loadAllInstances(): readonly AgentInstance[] {
    const rows = this.db.prepare('SELECT instance FROM instances ORDER BY rowid').all() as Array<{ instance: string }>
    return rows.map((row) => JSON.parse(row.instance) as AgentInstance)
  }

  // ---------- 资源 ----------

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  /**
   * 版本守卫（B5：拒载硬错，明示"旧格式，重建"）。身份模型换代（随机 id →
   * 出生路径 + 全局 name + 戳升级）不落迁移——旧空间删除 `.stem/stem.db`
   * 重建即是正解（类/策略/配置文件是文件真相，不受影响）。
   */
  private ensureSchema(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    const version = row.user_version
    if (version !== 0 && version !== SCHEMA_VERSION) {
      throw {
        kind: 'storage_schema_reject',
        found: version,
        supported: SCHEMA_VERSION,
        message: `空间数据库为旧格式（v${version}，本版本 v${SCHEMA_VERSION}）——身份模型换代零兼容，无迁移脚本：删除 .stem/stem.db 后重启即重建空间（.stem/ 配置文件与类/策略文件不受影响）`,
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id       TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        seq      INTEGER NOT NULL,
        message  TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages (agent_id, seq);
      CREATE TABLE IF NOT EXISTS instances (
        id       TEXT PRIMARY KEY,
        instance TEXT NOT NULL
      );
    `)
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
  }

}

/**
 * 组合根所需的 stateStore（两端口同一连接对象）。
 * SqliteStateStore 的方法名与端口契约差异（upsertInstance/deleteInstance）
 * 在此薄适配，避免 core 端口迁就驱动命名。
 */
export function createSqliteStateStore(
  file: string,
): { readonly messages: MessageStore; readonly instances: InstanceStore; close(): void } {
  const db = new SqliteStateStore(file)
  const messages: MessageStore = {
    upsert: (m) => db.upsertMessage(m),
    archiveAgent: (id) => db.archiveAgent(id),
    loadBoxes: () => db.loadBoxes(),
    maxMessageSeq: () => db.maxMessageSeq(),
    close: () => db.close(),
  }
  const instances: InstanceStore = {
    upsert: (i) => db.upsertInstance(i),
    delete: (id) => db.deleteInstance(id),
    loadAll: () => db.loadAllInstances(),
  }
  return { messages, instances, close: () => db.close() }
}
