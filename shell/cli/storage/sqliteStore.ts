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
//   - 迁移守卫：PRAGMA user_version（当前 2；高于本实现版本直接拒绝）。
// ============================================================

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { MessageStore, RestoredBox, StoredMessage } from '../../../src/core/context'
import { messageSeqOf } from '../../../src/core/context'
import type { InstanceStore } from '../../../src/core/kernel'
import type { AgentID, AgentInstance, AgentSpace, AgentSpaceID } from '../../../src/core/kernel'

/** 当前 schema 版本（PRAGMA user_version）。 */
const SCHEMA_VERSION = 2

/**
 * SQLite 个体层存储（驱动类：不直接 implements 两端口——
 * MessageStore.upsert 与 InstanceStore.upsert 同签名冲突，
 * 端口适配在 createSqliteStateStore 工厂完成）。
 */
export class SqliteStateStore {
  private readonly db: DatabaseSync
  private closed = false

  constructor(file: string, project: string) {
    mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.migrate(project)
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

  // ---------- 空间 ----------

  upsertSpace(space: AgentSpace): void {
    this.db
      .prepare('INSERT INTO spaces (id, space) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET space = excluded.space')
      .run(space.id, JSON.stringify(space))
  }

  deleteSpace(spaceId: AgentSpaceID): void {
    this.db.prepare('DELETE FROM spaces WHERE id = ?').run(spaceId)
  }

  loadSpaces(): readonly AgentSpace[] {
    const rows = this.db.prepare('SELECT space FROM spaces ORDER BY rowid').all() as Array<{ space: string }>
    return rows.map((row) => JSON.parse(row.space) as AgentSpace)
  }

  // ---------- 资源 ----------

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private migrate(project: string): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    const version = row.user_version
    if (version > SCHEMA_VERSION) {
      throw { kind: 'storage_schema_too_new', found: version, supported: SCHEMA_VERSION }
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
  CREATE TABLE IF NOT EXISTS spaces (
    id    TEXT PRIMARY KEY,
    space TEXT NOT NULL
  );
    `)
    if (version < 2) this.migrateV2(project)
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
  }

  /**
   * v1→v2（S6 批 1c）：根伪空间归并。旧实现 registerRootAgent 经
   * `getOrCreate('user0')` 造过 project='user0' 的伪空间行（根及其后代挂它），
   * 新语义 = 全体平等、根挂真实项目空间（`.stem` 目录即世界）。归并规则：
   *   - 存在其他空间行（真项目空间）→ 实例行 spaceId 全部迁到真空间、
   *     真空间 project 改写为当前启动目录（卷搬家也收敛）、删除伪行；
   *   - 只有伪行 → 直接转正（project 改为当前启动目录，空间 id 不变，零实例迁移）。
   * 一次性迁移后 user_version=2，永不再触发。
   */
  private migrateV2(project: string): void {
    const fake = this.db
      .prepare(`SELECT id FROM spaces WHERE json_extract(space, '$.project') = 'user0' ORDER BY rowid LIMIT 1`)
      .get() as { id: string } | undefined
    if (fake === undefined) {
      // 无伪行也保证空间行存在且项目身份收敛：同 project 旧行若有则改名对齐。
      const other = this.db
        .prepare(`SELECT id FROM spaces WHERE json_extract(space, '$.project') != ? ORDER BY rowid LIMIT 1`)
        .get(project) as { id: string } | undefined
      if (other !== undefined) {
        this.db.prepare(`UPDATE spaces SET space = json_set(space, '$.project', ?) WHERE id = ?`).run(project, other.id)
      }
      return
    }
    const real = this.db
      .prepare('SELECT id FROM spaces WHERE id != ? ORDER BY rowid LIMIT 1')
      .get(fake.id) as { id: string } | undefined
    if (real !== undefined) {
      this.db
        .prepare(`UPDATE instances SET instance = json_set(instance, '$.spaceId', ?) WHERE json_extract(instance, '$.spaceId') = ?`)
        .run(real.id, fake.id)
      this.db.prepare('DELETE FROM spaces WHERE id = ?').run(fake.id)
      this.db.prepare(`UPDATE spaces SET space = json_set(space, '$.project', ?) WHERE id = ?`).run(project, real.id)
    } else {
      this.db.prepare(`UPDATE spaces SET space = json_set(space, '$.project', ?) WHERE id = ?`).run(project, fake.id)
    }
  }
}

/**
 * 组合根所需的 stateStore（两端口同一连接对象）。
 * SqliteStateStore 的方法名与端口契约差异（upsertInstance/deleteInstance）
 * 在此薄适配，避免 core 端口迁就驱动命名。
 * `project` = 当前项目空间身份（S6/R11，v1→v2 根伪空间归并迁移用）。
 */
export function createSqliteStateStore(
  file: string,
  project: string,
): { readonly messages: MessageStore; readonly instances: InstanceStore; close(): void } {
  const db = new SqliteStateStore(file, project)
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
    upsertSpace: (s) => db.upsertSpace(s),
    deleteSpace: (id) => db.deleteSpace(id),
    loadSpaces: () => db.loadSpaces(),
  }
  return { messages, instances, close: () => db.close() }
}
