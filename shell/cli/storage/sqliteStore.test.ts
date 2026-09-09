// ============================================================
// shell/cli/storage/sqliteStore.test.ts —— SQLite 适配集成测试（真库）
//
// 含 B5 版本守卫（§H-10）：user_version 非 0 非当前 = 拒载硬错零兼容；
// B1 墓碑持久化：terminate 落归档行（不物理删），重启立计数器地板。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteStateStore } from './sqliteStore'
import { DefaultRepository, PersistedRepository } from '../../../src/core/context'
import {
  DefaultTemplateRegistry,
  DefaultInstanceManager,
  PersistedInstanceManager,
} from '../../../src/core/kernel'
import { makeAgentClassID, makeAgentID, makeAgentSpaceID, ROOT_ID } from '../../../src/core/kernel'
import type { AgentClass } from '../../../src/core/kernel'

const cls: AgentClass = {
  name: makeAgentClassID('worker'),
  description: 'worker',
  systemPrompt: 'work',
  tools: {},
}

async function withTempDb(run: (file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'stem-sqlite-'))
  try {
    await run(join(dir, 'stem.db'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** 第一生命周期：写入若干消息与实例后关闭。 */
async function seedLifecycle(file: string): Promise<{ ids: string[]; agentId: string }> {
  const store = createSqliteStateStore(file)
  const repository = new PersistedRepository(new DefaultRepository(), store.messages)
  const manager = new PersistedInstanceManager(new DefaultInstanceManager(new DefaultTemplateRegistry([cls])), store.instances)

  await repository.register('a1', 'sys')
  await repository.append('a1', { message: { role: 'user', content: 'hello' }, from: ROOT_ID })
  await repository.append('a1', { message: { role: 'assistant', content: 'hi' } })
  const invalidTarget = await repository.append('a1', { message: { role: 'tool', content: 'r', toolCallId: 'c1' } })
  await repository.markInvalid('a1', [invalidTarget.id])

  await manager.instantiate({ className: cls.name, parentId: null, userPrompt: '', spaceId: makeAgentSpaceID('s') })
  await manager.instantiate({ className: cls.name, parentId: ROOT_ID, userPrompt: 'go', spaceId: makeAgentSpaceID('s') })
  await manager.updateStatus(makeAgentID('0-1'), 'thinking')

  const ids = repository.list('a1').map((m) => m.id)
  store.close()
  return { ids, agentId: 'a1' }
}

describe('SqliteStateStore（真库 round-trip）', () => {
  test('写穿 → 重开连接全量恢复（id/turn/valid 保真，计数器续接）', async () => {
    await withTempDb(async (file) => {
      const { ids } = await seedLifecycle(file)

      // 第二生命周期：重开 store + 恢复装饰器内层。
      const store = createSqliteStateStore(file)
      const memory = new DefaultRepository()
      const repository = new PersistedRepository(memory, store.messages)
      repository.restoreFromStore()

      assert.deepEqual(
        repository.list('a1').map((m) => m.id),
        ids,
      )
      assert.equal(repository.list('a1')[1]?.from, ROOT_ID)
      assert.equal(repository.list('a1').some((m) => !m.valid), true)
      assert.equal(repository.list('a1').find((m) => !m.valid)?.id, ids[3])

      // 计数器续接：新 id 不与历史冲突。
      await repository.register('a2', 'sys2')
      const fresh = repository.list('a2')[0]!
      assert.ok(!ids.includes(fresh.id))

      // 实例恢复：状态归一化 thinking → interrupted。
      const instanceMemory = new DefaultInstanceManager(new DefaultTemplateRegistry([cls]))
      const instances = new PersistedInstanceManager(instanceMemory, store.instances)
      const restored = instances.restoreFromStore()
      assert.equal(restored.length, 2)
      assert.equal(instanceMemory.getSync(makeAgentID('0-1'))?.status, 'interrupted')
      store.close()
    })
  })

  test('terminate 落墓碑行（B1 地址占用持久）+ 消息归档；重启地板立住', async () => {
    await withTempDb(async (file) => {
      const store = createSqliteStateStore(file)
      const repository = new PersistedRepository(new DefaultRepository(), store.messages)
      const manager = new PersistedInstanceManager(new DefaultInstanceManager(new DefaultTemplateRegistry([cls])), store.instances)

      await repository.register('a1', 'sys')
      await repository.append('a1', { message: { role: 'user', content: 'hi' }, from: ROOT_ID })
      await manager.instantiate({ className: cls.name, parentId: null, userPrompt: '', spaceId: makeAgentSpaceID('s') })
      await manager.instantiate({ className: cls.name, parentId: ROOT_ID, userPrompt: 'go', spaceId: makeAgentSpaceID('s') })
      const archivedId = repository.list('a1')[0]!.id

      // 销毁 0-1：实例行转墓碑；其消息箱归档（此处 a1 即被销毁者的箱，模拟 unregister 路径）。
      await manager.terminate(makeAgentID('0-1'), { by: ROOT_ID })
      await repository.unregister('a1')

      const seq = store.messages.maxMessageSeq()
      store.close()

      // 重开：墓碑行在场（loadAll 可见、活体恢复不进名单），无 a1 恢复箱，序号守住。
      const store2 = createSqliteStateStore(file)
      assert.equal(store2.instances.loadAll().find((i) => i.id === '0-1')?.status, 'terminated')
      const memory = new DefaultInstanceManager(new DefaultTemplateRegistry([cls]))
      const instances = new PersistedInstanceManager(memory, store2.instances)
      assert.equal(instances.restoreFromStore().length, 1, '墓碑不进恢复接线名单')
      const next = await instances.instantiate({ className: cls.name, parentId: ROOT_ID, userPrompt: 'go2', spaceId: makeAgentSpaceID('s') })
      assert.equal(next.id, '0-2', '墓碑 0-1 占位：新出生跳号')
      assert.equal(store2.messages.loadBoxes().some((b) => b.agentId === 'a1'), false)
      assert.equal(store2.messages.maxMessageSeq(), seq)
      assert.ok(seq > Number(archivedId.replace('m-', '')))
      store2.close()
    })
  })

  test('schema 守卫：user_version 幂等（重开不重建不报错）', async () => {
    await withTempDb(async (file) => {
      const first = createSqliteStateStore(file)
      first.close()
      const second = createSqliteStateStore(file) // 同版本重开 ✔
      assert.equal(second.messages.loadBoxes().length, 0)
      second.close()
    })
  })
})

// ---------- B5 版本守卫（§H-10）：任何非当前版本 = 拒载硬错（零兼容零迁移） ----------

/** 造一份旧格式 DB（v2 形态：随机 id + displayName 字段的实例行）。 */
async function seedOld(file: string, version: number): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE messages (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, seq INTEGER NOT NULL, message TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE instances (id TEXT PRIMARY KEY, instance TEXT NOT NULL);
    CREATE TABLE spaces (id TEXT PRIMARY KEY, space TEXT NOT NULL);
  `)
  db.prepare('INSERT INTO instances VALUES (?, ?)').run(
    'bso2',
    JSON.stringify({
      id: 'bso2', classRef: 'user', parentId: null, displayName: '0',
      spaceId: 'space-1', status: 'idle', turnCount: 0, totalCost: 0, totalTokens: 0, userPrompt: '',
    }),
  )
  db.prepare('INSERT INTO spaces VALUES (?, ?)').run('space-1', JSON.stringify({ id: 'space-1', project: '/old' }))
  db.exec(`PRAGMA user_version = ${version}`)
  db.close()
}

async function expectReject(open: () => unknown, found: number): Promise<void> {
  try {
    open()
    assert.fail('旧格式 DB 应拒载')
  } catch (e) {
    const err = e as { kind?: string; found?: number; supported?: number; message?: string }
    assert.equal(err.kind, 'storage_schema_reject')
    assert.equal(err.found, found)
    assert.equal(err.supported, 3)
    assert.match(String(err.message), /重建/)
  }
}

describe('schema v3 拒载（零历史兼容）', () => {
  test('v2 旧库（随机 id + displayName 时代）→ 硬错指路重建', async () => {
    await withTempDb(async (file) => {
      await seedOld(file, 2)
      await expectReject(() => createSqliteStateStore(file), 2)
    })
  })

  test('v1 旧库 → 同样拒载（无逐级迁移）', async () => {
    await withTempDb(async (file) => {
      await seedOld(file, 1)
      await expectReject(() => createSqliteStateStore(file), 1)
    })
  })

  test('未来版本（比实现新）→ 拒载', async () => {
    await withTempDb(async (file) => {
      await seedOld(file, 99)
      await expectReject(() => createSqliteStateStore(file), 99)
    })
  })
})
