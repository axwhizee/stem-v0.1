// ============================================================
// core/kernel/persisted.test.ts —— 实例持久化端口 + write-through 装饰器
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DefaultTemplateRegistry } from './TemplateRegistry'
import { DefaultInstanceManager } from './InstanceManager'
import { PersistedInstanceManager } from './persisted'
import { MemoryInstanceStore } from './store'
import type { AgentClass, AgentInstance } from './types'
import { makeAgentClassID, makeAgentID, makeAgentSpaceID } from './types'

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

function rowOf(store: MemoryInstanceStore, id: string): AgentInstance | undefined {
  return store.loadAll().find((r) => r.id === id)
}

describe('PersistedInstanceManager write-through', () => {
  test('instantiate / updateStatus / update 全字段快照落行', async () => {
    const { manager, store } = makePersisted()
    const created = await manager.instantiate({
      className: cls.name, parentId: null, userPrompt: '', spaceId: makeAgentSpaceID('s'), agentId: 'a1',
    })
    await manager.updateStatus(created.id, 'thinking')
    await manager.update(created.id, { displayName: 'renamed' })

    const row = rowOf(store, 'a1')
    assert.equal(row?.status, 'thinking')
    assert.equal(row?.displayName, 'renamed')
    assert.equal(row?.classRef, cls.name)
  })

  test('recordTurnEnd 账目累加即落行（重启不丢的回归锚）', async () => {
    const { manager, store } = makePersisted()
    const created = await manager.instantiate({
      className: cls.name, parentId: null, userPrompt: '', spaceId: makeAgentSpaceID('s'), agentId: 'a1',
    })
    await manager.recordTurnEnd(created.id, { turns: 1, cost: 0.25 })
    await manager.recordTurnEnd(created.id, { turns: 1, cost: 0.5 })
    const row = rowOf(store, 'a1')
    assert.equal(row?.turnCount, 2, '行快照应含两轮累加')
    assert.equal(row?.totalCost, 0.75)
  })

  test('terminate recursive：级联子体一并从 store 消行（杜绝漏删）', async () => {
    const { manager, store } = makePersisted()
    await manager.instantiate({ className: cls.name, parentId: null, userPrompt: '', spaceId: makeAgentSpaceID('s'), agentId: 'root' })
    await manager.instantiate({ className: cls.name, parentId: makeAgentID('root'), userPrompt: 'hi', spaceId: makeAgentSpaceID('s'), agentId: 'mid' })
    await manager.instantiate({ className: cls.name, parentId: makeAgentID('mid'), userPrompt: 'hi', spaceId: makeAgentSpaceID('s'), agentId: 'leaf' })

    // mid 的合法祖先 root 递归销毁 mid 子树：mid + leaf 两行都应消掉。
    await manager.terminate(makeAgentID('mid'), { by: makeAgentID('root'), recursive: true })
    assert.equal(rowOf(store, 'mid'), undefined)
    assert.equal(rowOf(store, 'leaf'), undefined)
    assert.ok(rowOf(store, 'root'))
  })

  test('terminate 销毁权失败时不落删除（fail-fast 先于副作用）', async () => {
    const { manager, store } = makePersisted()
    await manager.instantiate({ className: cls.name, parentId: null, userPrompt: '', spaceId: makeAgentSpaceID('s'), agentId: 'root' })
    await manager.instantiate({ className: cls.name, parentId: makeAgentID('root'), userPrompt: '', spaceId: makeAgentSpaceID('s'), agentId: 'kid' })
    await manager.instantiate({ className: cls.name, parentId: null, userPrompt: '', spaceId: makeAgentSpaceID('s'), agentId: 'outsider' })

    await assert.rejects(
      () => manager.terminate(makeAgentID('kid'), { by: makeAgentID('outsider') }),
      (error: unknown) => (error as { kind: string }).kind === 'agent_terminate_denied',
    )
    assert.ok(rowOf(store, 'kid'))
  })

  test('有子且非 recursive：抛错且不删行', async () => {
    const { manager, store } = makePersisted()
    await manager.instantiate({ className: cls.name, parentId: null, userPrompt: '', spaceId: makeAgentSpaceID('s'), agentId: 'root' })
    await manager.instantiate({ className: cls.name, parentId: makeAgentID('root'), userPrompt: '', spaceId: makeAgentSpaceID('s'), agentId: 'mid' })
    await manager.instantiate({ className: cls.name, parentId: makeAgentID('mid'), userPrompt: '', spaceId: makeAgentSpaceID('s'), agentId: 'leaf' })

    await assert.rejects(
      () => manager.terminate(makeAgentID('mid'), { by: makeAgentID('root'), recursive: false }),
      (error: unknown) => (error as { kind: string }).kind === 'agent_has_children',
    )
    assert.ok(rowOf(store, 'mid'))
    assert.ok(rowOf(store, 'leaf'))
  })
})

describe('PersistedInstanceManager 恢复', () => {
  test('restoreFromStore：装载实例并归一化活跃状态为 interrupted', async () => {
    const store = new MemoryInstanceStore()
    store.upsert({
      id: makeAgentID('a1'), classRef: cls.name, parentId: null, displayName: 'a1',
      spaceId: makeAgentSpaceID('s'), status: 'thinking', turnCount: 3, totalCost: 0.5, userPrompt: 'hi',
    })

    const { manager } = makePersisted(store)
    const restored = manager.restoreFromStore()
    assert.equal(restored.length, 1)
    assert.equal(manager.getSync(makeAgentID('a1'))?.status, 'interrupted')
  })

  test('restore 幂等：已存在 id 跳过', async () => {
    const { manager } = makePersisted()
    await manager.instantiate({ className: cls.name, parentId: null, userPrompt: 'first', spaceId: makeAgentSpaceID('s'), agentId: 'a1' })
    manager.restore({
      id: makeAgentID('a1'), classRef: cls.name, parentId: null, displayName: 'ghost',
      spaceId: makeAgentSpaceID('s'), status: 'idle', turnCount: 9, totalCost: 0, userPrompt: 'second',
    })
    assert.equal((await manager.get(makeAgentID('a1'))).userPrompt, 'first')
  })
})
