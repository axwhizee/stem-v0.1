// ============================================================
// core/kernel/persisted.test.ts —— 实例持久化端口 + write-through 装饰器
// （含 B1 墓碑语义：terminate = 落归档行，不物理删）
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DefaultTemplateRegistry } from './TemplateRegistry'
import { DefaultInstanceManager } from './InstanceManager'
import { PersistedInstanceManager } from './persisted'
import { MemoryInstanceStore } from '../../../test/support/memoryInstanceStore'
import type { AgentClass } from './types'
import { makeAgentClassID, makeAgentID, makeAgentSpaceID, ROOT_ID } from './types'

const cls: AgentClass = {
  name: makeAgentClassID('worker'),
  description: 'worker',
  systemPrompt: 'work',
  tools: {},
}

function makePersisted(store: MemoryInstanceStore = new MemoryInstanceStore()) {
  const registry = new DefaultTemplateRegistry([cls])
  const memory = new DefaultInstanceManager(registry)
  return { manager: new PersistedInstanceManager(memory, store), store, registry }
}

function rowOf(store: MemoryInstanceStore, id: string): AgentClass extends never ? never : ReturnType<MemoryInstanceStore['loadAll']>[number] | undefined {
  return store.loadAll().find((r) => r.id === id)
}

describe('PersistedInstanceManager write-through', () => {
  test('instantiate / updateStatus / update 全字段快照落行', async () => {
    const { manager, store } = makePersisted()
    const created = await manager.instantiate({
      className: cls.name, parentId: null, userPrompt: '', spaceId: makeAgentSpaceID('s'),
    })
    assert.equal(created.id, ROOT_ID, '根 = 出生路径 0')
    await manager.updateStatus(created.id, 'thinking')
    await manager.update(created.id, { name: 'renamed' })

    const row = rowOf(store, ROOT_ID)
    assert.equal(row?.status, 'thinking')
    assert.equal(row?.name, 'renamed')
    assert.equal(row?.classRef, cls.name)
  })

  test('recordTurnEnd 账目累加即落行（重启不丢的回归锚）', async () => {
    const { manager, store } = makePersisted()
    const created = await manager.instantiate({
      className: cls.name, parentId: null, userPrompt: '', spaceId: makeAgentSpaceID('s'),
    })
    await manager.recordTurnEnd(created.id, { turns: 1, cost: 0.25 })
    await manager.recordTurnEnd(created.id, { turns: 1, cost: 0.5 })
    const row = rowOf(store, ROOT_ID)
    assert.equal(row?.turnCount, 2, '行快照应含两轮累加')
    assert.equal(row?.totalCost, 0.75)
  })

  test('terminate recursive：级联子体一并落墓碑行（地址与称呼占用是持久事实）', async () => {
    const { manager, store } = makePersisted()
    const spaceId = makeAgentSpaceID('s')
    await manager.instantiate({ className: cls.name, parentId: null, userPrompt: '', spaceId })
    const mid = makeAgentID('0-1')
    await manager.instantiate({ className: cls.name, parentId: ROOT_ID, userPrompt: 'hi', spaceId })
    await manager.instantiate({ className: cls.name, parentId: mid, userPrompt: 'hi', spaceId })

    // root 递归销毁唯一子 mid：mid + leaf（0-1-1）两行都转墓碑，root 行存活。
    await manager.terminate(mid, { by: ROOT_ID, recursive: true })
    assert.equal(rowOf(store, mid)?.status, 'terminated')
    assert.equal(rowOf(store, '0-1-1')?.status, 'terminated')
    assert.equal(rowOf(store, ROOT_ID)?.status, 'idle')
  })

  test('terminate 销毁权失败时不落墓碑（fail-fast 先于副作用）', async () => {
    const { manager, store } = makePersisted()
    const spaceId = makeAgentSpaceID('s')
    await manager.instantiate({ className: cls.name, parentId: null, userPrompt: '', spaceId })
    const kid = makeAgentID('0-1')
    await manager.instantiate({ className: cls.name, parentId: ROOT_ID, userPrompt: '', spaceId })
    // 另起一个独立 manager 的"外人"不共享行集；用兄弟位模拟无销毁权：
    const sib = makeAgentID('0-2')
    await manager.instantiate({ className: cls.name, parentId: ROOT_ID, userPrompt: '', spaceId })
    // sib 不是 kid 的祖先（结构上是兄弟）——但根可以……销毁权 by=sib 拒。
    await assert.rejects(
      () => manager.terminate(kid, { by: sib }),
      (error: unknown) => (error as { kind: string }).kind === 'agent_terminate_denied',
    )
    assert.ok(rowOf(store, '0-1'))
  })

  test('有子且非 recursive：抛错且不落墓碑', async () => {
    const { manager, store } = makePersisted()
    const spaceId = makeAgentSpaceID('s')
    await manager.instantiate({ className: cls.name, parentId: null, userPrompt: '', spaceId })
    await manager.instantiate({ className: cls.name, parentId: ROOT_ID, userPrompt: '', spaceId })
    await manager.instantiate({ className: cls.name, parentId: makeAgentID('0-1'), userPrompt: '', spaceId })

    await assert.rejects(
      () => manager.terminate(makeAgentID('0-1'), { by: ROOT_ID, recursive: false }),
      (error: unknown) => (error as { kind: string }).kind === 'agent_has_children',
    )
    assert.ok(rowOf(store, '0-1'))
    assert.notEqual(rowOf(store, '0-1')?.status, 'terminated')
  })
})

describe('PersistedInstanceManager 恢复', () => {
  test('restoreFromStore：活体行归一化 interrupted；墓碑行只立占用不进名单', async () => {
    const store = new MemoryInstanceStore()
    const s = makeAgentSpaceID('s')
    store.upsert({
      id: ROOT_ID, classRef: cls.name, parentId: null, name: 'worker-1',
      spaceId: s, status: 'idle', turnCount: 1, totalCost: 0, userPrompt: '',
    })
    store.upsert({
      id: makeAgentID('0-1'), classRef: cls.name, parentId: ROOT_ID, name: 'worker-2',
      spaceId: s, status: 'thinking', turnCount: 3, totalCost: 0.5, userPrompt: 'hi',
    })
    store.upsert({
      id: makeAgentID('0-7'), classRef: cls.name, parentId: ROOT_ID, name: 'worker-8',
      spaceId: s, status: 'terminated', turnCount: 1, totalCost: 0, userPrompt: 'hi',
    })

    const { manager } = makePersisted(store)
    const restored = manager.restoreFromStore()
    assert.equal(restored.length, 2, '墓碑不进恢复接线名单')
    assert.equal(manager.getSync(makeAgentID('0-1'))?.status, 'interrupted')
    assert.equal(manager.getSync(makeAgentID('0-7')), undefined, '墓碑不在活体面')
    const next = await manager.instantiate({ className: cls.name, parentId: ROOT_ID, userPrompt: 'hi', spaceId: s })
    assert.equal(next.id, '0-8', '墓碑立计数器地板')
    assert.equal(next.name, 'worker-9', '墓碑占名，派生名避让')
  })

  test('restore 幂等：已存在 id 跳过', async () => {
    const { manager } = makePersisted()
    await manager.instantiate({ className: cls.name, parentId: null, userPrompt: 'first', spaceId: makeAgentSpaceID('s') })
    manager.restore({
      id: makeAgentID(ROOT_ID), classRef: cls.name, parentId: null, name: 'ghost',
      spaceId: makeAgentSpaceID('s'), status: 'idle', turnCount: 9, totalCost: 0, userPrompt: 'second',
    })
    assert.equal((await manager.get(ROOT_ID)).userPrompt, 'first')
  })

  test('装载期撞名 = 硬错（B2 唯一性 boot 审判；文件真相被手改的形态）', async () => {
    const store = new MemoryInstanceStore()
    const s = makeAgentSpaceID('s')
    store.upsert({
      id: makeAgentID('0-1'), classRef: cls.name, parentId: null, name: 'twin',
      spaceId: s, status: 'idle', turnCount: 0, totalCost: 0, userPrompt: '',
    })
    store.upsert({
      id: makeAgentID('0-2'), classRef: cls.name, parentId: null, name: 'twin',
      spaceId: s, status: 'idle', turnCount: 0, totalCost: 0, userPrompt: '',
    })
    const { manager } = makePersisted(store)
    assert.throws(
      () => manager.restoreFromStore(),
      (e: unknown) => (e as { kind: string }).kind === 'agent_name_conflict',
    )
  })

  test('寻址与呈现直通装饰器（resolve/displayOf 门面等价）', async () => {
    const { manager } = makePersisted()
    const a = await manager.instantiate({ className: cls.name, parentId: null, userPrompt: '', spaceId: makeAgentSpaceID('s'), name: 'boss' })
    assert.deepEqual(manager.resolve('boss'), { found: a.id })
    assert.equal(manager.displayOf(a.id), 'boss#0')
  })
})
