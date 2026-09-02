// ============================================================
// core/context/persisted.test.ts —— 消息持久化端口 + write-through 装饰器
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DefaultRepository } from './Repository'
import { PersistedRepository } from './persisted'
import { MemoryMessageStore, messageSeqOf } from './store'

/** 建一对（内存核 + store + 装饰器），返回装饰器与 store 引用供断言。 */
function makePersisted(store: MemoryMessageStore = new MemoryMessageStore()) {
  const memory = new DefaultRepository()
  const repository = new PersistedRepository(memory, store)
  return { repository, store }
}

async function seed(repository: PersistedRepository): Promise<void> {
  await repository.register('a1', 'sys-1')
  await repository.append('a1', { message: { role: 'user', content: 'hello' }, from: 'user0' })
  await repository.append('a1', { message: { role: 'assistant', content: 'hi' } })
  await repository.append('a1', { message: { role: 'user', content: 'again' } })
  await repository.append('a1', { message: { role: 'assistant', content: 'thinking' }, tag: 'summary' })
}

describe('PersistedRepository write-through', () => {
  test('register/append 同步落行（含 system 行与 tag/from）', async () => {
    const { repository, store } = makePersisted()
    await seed(repository)

    const boxes = store.loadBoxes()
    assert.equal(boxes.length, 1)
    assert.equal(boxes[0]?.messages.length, 5)
    const [sys, u, a] = boxes[0]!.messages
    assert.equal(sys?.message.role, 'system')
    assert.equal(u?.message.role, 'user')
    assert.equal(u?.from, 'user0')
    assert.equal(boxes[0]?.messages[4]?.tag, 'summary')
  })

  test('setTokens：真实计量回填同步落行 + 恢复往返保真（T3）', async () => {
    const { repository, store } = makePersisted()
    await seed(repository)
    const rows = store.loadBoxes()[0]!.messages
    const toolRow = rows[2]! // assistant 'hi'
    await repository.setTokens('a1', toolRow.id, 4242)
    // 写穿：store 行 JSON 整体序列化，tokens 零 schema 迁移。
    const persisted = store.loadBoxes()[0]!.messages.find((m) => m.id === toolRow.id)
    assert.equal(persisted?.tokens, 4242)
    // 恢复往返：新装饰器从 store 重建后真实值存活。
    const fresh = makePersisted(new MemoryMessageStore())
    fresh.store.upsert({ ...persisted! })
    fresh.repository.restoreFromStore()
    const restored = fresh.repository.list('a1').find((m) => m.id === toolRow.id)
    assert.equal(restored?.tokens, 4242)
    // 幂等 no-op：不存在行不抛。
    await repository.setTokens('a1', 'no-such', 1)
  })

  test('markInvalid / updateMessage 收敛到行（valid 位与正文落库）', async () => {    const { repository, store } = makePersisted()
    await seed(repository)
    const msgs = repository.list('a1')
    await repository.markInvalid('a1', [msgs[1]!.id])
    await repository.updateMessage('a1', msgs[2]!.id, { role: 'assistant', content: 'edited' })

    const rows = store.loadBoxes()[0]!.messages
    assert.equal(rows[1]?.valid, false)
    assert.equal(rows[2]?.message.content, 'edited')
  })

  test('unregister = 归档：loadBoxes 不含该箱，但 maxMessageSeq 仍计入（防撞）', async () => {
    const { repository, store } = makePersisted()
    await seed(repository)
    const before = store.maxMessageSeq()
    await repository.unregister('a1')

    assert.equal(store.loadBoxes().length, 0)
    assert.ok(store.maxMessageSeq() >= before)
  })
})

describe('PersistedRepository 恢复', () => {
  test('restoreFromStore：全字段重建（id/turn/indexInTurn/valid/tag/from）', async () => {
    const store = new MemoryMessageStore()
    const original = makePersisted(store)
    await seed(original.repository)
    await original.repository.markInvalid('a1', [original.repository.list('a1')[1]!.id])
    const live = original.repository.list('a1')

    const revived = makePersisted(store)
    revived.repository.restoreFromStore()
    const restored = revived.repository.list('a1')

    assert.deepEqual(
      restored.map((m) => ({ id: m.id, role: m.message.role, turn: m.turn, indexInTurn: m.indexInTurn, valid: m.valid })),
      live.map((m) => ({ id: m.id, role: m.message.role, turn: m.turn, indexInTurn: m.indexInTurn, valid: m.valid })),
    )
    assert.equal(restored[1]?.from, 'user0')
    assert.equal(restored[4]?.tag, 'summary')
  })

  test('恢复后追加：turn 计数器与 id 计数器精确续接（与不间断运行等轨）', async () => {
    const store = new MemoryMessageStore()
    // 等轨 A：不间断跑。
    const live = makePersisted(store)
    await seed(live.repository)
    await live.repository.append('a1', { message: { role: 'assistant', content: 'continuation' } })
    const trackA = live.repository.list('a1').slice(5)

    // 等轨 B：seed 后"重启"再追加（独立 store 副本模拟跨进程）。
    const storeB = new MemoryMessageStore()
    const first = makePersisted(storeB)
    await seed(first.repository)
    const revived = makePersisted(storeB)
    revived.repository.restoreFromStore()
    await revived.repository.append('a1', { message: { role: 'assistant', content: 'continuation' } })
    const trackB = revived.repository.list('a1').slice(5)

    assert.equal(trackA[0]?.turn, 2)
    assert.equal(trackA[0]?.indexInTurn, 2)
    assert.deepEqual(
      trackB.map((m) => ({ role: m.message.role, turn: m.turn, indexInTurn: m.indexInTurn })),
      trackA.map((m) => ({ role: m.message.role, turn: m.turn, indexInTurn: m.indexInTurn })),
    )
    assert.equal(messageSeqOf(trackB[0]!.id), messageSeqOf(trackA[0]!.id))
  })

  test('归档行不参与恢复，但 id 计数器避开历史序号', async () => {
    const store = new MemoryMessageStore()
    const first = makePersisted(store)
    await seed(first.repository) // a1 用掉 m-1..m-5
    await first.repository.unregister('a1') // 归档 m-1..m-5

    const revived = makePersisted(store)
    revived.repository.restoreFromStore()
    await revived.repository.register('a2', 'sys')
    const fresh = revived.repository.list('a2')
    assert.equal(fresh.length, 1)
    assert.ok(messageSeqOf(fresh[0]!.id) > 5, `新 id ${String(fresh[0]?.id)} 应避开归档序号`)
    assert.equal(revived.repository.has('a1'), false)
  })

  test('restore 幂等：箱已存在时跳过（不覆盖不抛错）', () => {
    const memory = new DefaultRepository()
    memory.restore('x', [
      { id: 'm-9', agentId: 'x', message: { role: 'user', content: 'a' }, at: 1, tokens: 1, valid: true, turn: 0, indexInTurn: 0 },
    ])
    memory.restore('x', [{ ...memory.list('x')[0]!, id: 'm-99' }])
    assert.equal(memory.list('x').length, 1)
    assert.equal(memory.list('x')[0]?.id, 'm-9')
  })
})
