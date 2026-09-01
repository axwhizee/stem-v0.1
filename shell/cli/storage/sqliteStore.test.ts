// ============================================================
// shell/cli/storage/sqliteStore.test.ts —— SQLite 适配集成测试（真库）
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
import { makeAgentClassID, makeAgentID, makeAgentSpaceID } from '../../../src/core/kernel'
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
  const store = createSqliteStateStore(file, '/proj/demo')
  const repository = new PersistedRepository(new DefaultRepository(), store.messages)
  const manager = new PersistedInstanceManager(new DefaultInstanceManager(new DefaultTemplateRegistry([cls])), store.instances)

  await repository.register('a1', 'sys')
  await repository.append('a1', { message: { role: 'user', content: 'hello' }, from: 'user0' })
  await repository.append('a1', { message: { role: 'assistant', content: 'hi' } })
  const invalidTarget = await repository.append('a1', { message: { role: 'tool', content: 'r', toolCallId: 'c1' } })
  await repository.markInvalid('a1', [invalidTarget.id])

  await manager.instantiate({ className: cls.name, parentId: null, userPrompt: '', spaceId: makeAgentSpaceID('s'), agentId: 'root' })
  await manager.instantiate({ className: cls.name, parentId: makeAgentID('root'), userPrompt: 'go', spaceId: makeAgentSpaceID('s'), agentId: 'kid' })
  await manager.updateStatus(makeAgentID('kid'), 'thinking')

  const ids = repository.list('a1').map((m) => m.id)
  store.close()
  return { ids, agentId: 'a1' }
}

describe('SqliteStateStore（真库 round-trip）', () => {
  test('写穿 → 重开连接全量恢复（id/turn/valid 保真，计数器续接）', async () => {
    await withTempDb(async (file) => {
      const { ids } = await seedLifecycle(file)

      // 第二生命周期：重开 store + 恢复装饰器内层。
      const store = createSqliteStateStore(file, '/proj/demo')
      const memory = new DefaultRepository()
      const repository = new PersistedRepository(memory, store.messages)
      repository.restoreFromStore()

      assert.deepEqual(
        repository.list('a1').map((m) => m.id),
        ids,
      )
      assert.equal(repository.list('a1')[1]?.from, 'user0')
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
      assert.equal(instanceMemory.getSync(makeAgentID('kid'))?.status, 'interrupted')
      store.close()
    })
  })

  test('terminate 语义贯通：实例消行 + 消息归档；归档不入恢复但计入序号', async () => {
    await withTempDb(async (file) => {
      const store = createSqliteStateStore(file, '/proj/demo')
      const repository = new PersistedRepository(new DefaultRepository(), store.messages)
      const manager = new PersistedInstanceManager(new DefaultInstanceManager(new DefaultTemplateRegistry([cls])), store.instances)

      await repository.register('a1', 'sys')
      await repository.append('a1', { message: { role: 'user', content: 'hi' }, from: 'user0' })
      await manager.instantiate({ className: cls.name, parentId: null, userPrompt: '', spaceId: makeAgentSpaceID('s'), agentId: 'root' })
      await manager.instantiate({ className: cls.name, parentId: makeAgentID('root'), userPrompt: 'go', spaceId: makeAgentSpaceID('s'), agentId: 'kid' })
      const archivedId = repository.list('a1')[0]!.id

      // 销毁 kid：实例行删除；其消息箱归档（此处 a1 即 kid 的箱，模拟 unregister 路径）。
      await manager.terminate(makeAgentID('kid'), { by: makeAgentID('root') })
      await repository.unregister('a1')

      const seq = store.messages.maxMessageSeq()
      store.close()

      // 重开：无实例行（kid 删、root 在），无 a1 恢复箱，但序号守住。
      const store2 = createSqliteStateStore(file, '/proj/demo')
      assert.equal(store2.instances.loadAll().some((i) => i.id === 'kid'), false)
      assert.equal(store2.messages.loadBoxes().some((b) => b.agentId === 'a1'), false)
      assert.equal(store2.messages.maxMessageSeq(), seq)
      assert.ok(seq > Number(archivedId.replace('m-', '')))
      store2.close()
    })
  })

  test('schema 守卫：user_version 幂等（重开不重建不报错）', async () => {
    await withTempDb(async (file) => {
      const first = createSqliteStateStore(file, '/proj/demo')
      first.close()
      const second = createSqliteStateStore(file, '/proj/demo') // 同版本重开 ✔
      assert.equal(second.messages.loadBoxes().length, 0)
      second.close()
    })
  })
})

// ---------- S6 批 1c：v1→v2 根伪空间归并迁移（老卷直接升级） ----------

async function seedV1(file: string, opts: { withReal: boolean }): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE spaces (id TEXT PRIMARY KEY, space TEXT NOT NULL);
    CREATE TABLE instances (id TEXT PRIMARY KEY, instance TEXT NOT NULL);
  `)
  const instanceRow = (id: string, spaceId: string) =>
    JSON.stringify({
      id,
      classRef: id === 'user0' ? 'user' : 'worker',
      parentId: id === 'user0' ? null : 'user0',
      displayName: id,
      spaceId,
      status: 'idle',
      turnCount: 0,
      totalCost: 0,
      userPrompt: '',
    })
  // v1 形态：根伪空间（project='user0'）+ 根与后代挂它。
  db.prepare('INSERT INTO spaces VALUES (?, ?)').run('space-1', JSON.stringify({ id: 'space-1', project: 'user0' }))
  db.prepare('INSERT INTO instances VALUES (?, ?)').run('user0', instanceRow('user0', 'space-1'))
  db.prepare('INSERT INTO instances VALUES (?, ?)').run('a1', instanceRow('a1', 'space-1'))
  if (opts.withReal) {
    db.prepare('INSERT INTO spaces VALUES (?, ?)').run('space-2', JSON.stringify({ id: 'space-2', project: '/old/path' }))
  }
  db.exec('PRAGMA user_version = 1')
  db.close()
}

describe('v1→v2 根伪空间归并（S6/R11 空间语义修正）', () => {
  test('只有伪行 → 直接转正（project 改写为当前启动目录，实例行零迁移）', async () => {
    await withTempDb(async (file) => {
      await seedV1(file, { withReal: false })
      const store = createSqliteStateStore(file, '/proj/newhome')
      const spaces = store.instances.loadSpaces()
      assert.equal(spaces.length, 1)
      assert.equal(spaces[0]?.project, '/proj/newhome')
      assert.equal(spaces[0]?.id, 'space-1', '空间 id 不变（实例行引用零迁移）')
      assert.ok(store.instances.loadAll().every((row) => row.spaceId === 'space-1'))
      store.close()
      // 幂等：再次打开（同/异 project）都不再动（user_version=2）。
      const again = createSqliteStateStore(file, '/elsewhere')
      assert.equal(again.instances.loadSpaces()[0]?.project, '/proj/newhome')
      again.close()
    })
  })

  test('伪行 + 真空间并存 → 实例全并真空间、伪行删除、真空间 project 收敛当前目录', async () => {
    await withTempDb(async (file) => {
      await seedV1(file, { withReal: true })
      const store = createSqliteStateStore(file, '/data')
      const spaces = store.instances.loadSpaces()
      assert.equal(spaces.length, 1, '空间行唯一（无 user0 专属伪行）')
      assert.equal(spaces[0]?.id, 'space-2')
      assert.equal(spaces[0]?.project, '/data')
      const rows = store.instances.loadAll()
      assert.equal(rows.length, 2)
      assert.ok(rows.every((row) => row.spaceId === 'space-2'), '根与后代全部归并真空间')
      store.close()
    })
  })
})
