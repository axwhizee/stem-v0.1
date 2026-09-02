// ============================================================
// core/context/Repository.test.ts —— 仓库 tag + 双索引 + 导出/概览
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DefaultRepository } from './Repository'
import { DefaultCourier } from './Courier'
import { DefaultContextManager } from './ContextManager'
import type { ChatMessage } from '../gateway'

function makeRepo() {
  const repository = new DefaultRepository()
  const courier = new DefaultCourier({ repository, defaultCountdownMs: 0 })
  const contextManager = new DefaultContextManager({ repository, courier })
  repository.onChange = (agentId) => contextManager.handleChange(agentId)
  return { repository, contextManager }
}

describe('Repository tag + 双索引', () => {
  test('user 消息开启新轮，其余消息轮内递增', async () => {
    const { repository } = makeRepo()
    await repository.register('a1', 'sys')
    await repository.append('a1', { message: { role: 'user', content: 'u1' } })
    await repository.append('a1', { message: { role: 'assistant', content: 'a1' } })
    await repository.append('a1', { message: { role: 'user', content: 'u2' } })
    await repository.append('a1', { message: { role: 'assistant', content: 'a2' } })

    const msgs = repository.list('a1')
    // system 在第 0 轮第 0 条
    assert.deepEqual(
      msgs.map((m) => [m.message.role, m.turn, m.indexInTurn]),
      [
        ['system', 0, 0],
        ['user', 1, 0],
        ['assistant', 1, 1],
        ['user', 2, 0],
        ['assistant', 2, 1],
      ],
    )
  })

  test('tag 标记合成消息（非原生），缺省无 tag', async () => {
    const { repository } = makeRepo()
    await repository.register('a1', 'sys')
    await repository.append('a1', { message: { role: 'user', content: 'u' } })
    await repository.append('a1', { message: { role: 'assistant', content: 'a' }, tag: 'summary' })

    const msgs = repository.list('a1')
    assert.equal(msgs[1]?.tag, undefined)
    assert.equal(msgs[2]?.tag, 'summary')
  })
})

describe('ContextManager 导出/概览', () => {
  test('exportJsonl：逐行 JSON 含 tag/turn/indexInTurn', async () => {
    const { contextManager } = makeRepo()
    await contextManager.register({ agentId: 'a1', systemPrompt: 'sys', onDelivery: () => {} })
    await contextManager.deposit('a1', { role: 'user', content: 'hi' })
    await contextManager.appendHistory('a1', { role: 'assistant', content: 'hello' }, { tag: 'summary' })

    const jsonl = await contextManager.exportJsonl('a1')
    const lines = jsonl.split('\n').filter(Boolean)
    assert.equal(lines.length, 3)
    const parsed = JSON.parse(lines[2]!) as { role: string; tag?: string; turn: number; indexInTurn: number }
    assert.equal(parsed.role, 'assistant')
    assert.equal(parsed.tag, 'summary')
    assert.equal(parsed.turn, 1)
    assert.equal(parsed.indexInTurn, 1)
  })

  test('overview：只读反射含 role/turn/tag/token 占比', async () => {
    const { contextManager } = makeRepo()
    await contextManager.register({ agentId: 'a1', systemPrompt: 'sys', onDelivery: () => {} })
    await contextManager.deposit('a1', { role: 'user', content: 'hi' })

    const overview = await contextManager.overview('a1')
    assert.match(overview, /上下文概览 a1/)
    assert.match(overview, /\[0:0\] system/)
    assert.match(overview, /\[1:0\] user/)
  })
})
