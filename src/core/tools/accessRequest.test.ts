// ============================================================
// core/tools/accessRequest.test.ts —— ask 消息化总线单测
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DefaultAccessAskBus, formatAccessRequest } from './accessRequest'

const makeBus = (overrides: { getRoot?: (id: string) => string } = {}) => {
  const asked: unknown[] = []
  const bus = new DefaultAccessAskBus({
    askRoot: (req) => void asked.push(req),
    getRoot: overrides.getRoot ?? (() => 'user0'),
  })
  return { bus, asked }
}

describe('DefaultAccessAskBus（ask 消息化）', () => {
  test('ask → 投递申请到根信箱（askRoot 收到带 id 的请求）', async () => {
    const { bus, asked } = makeBus()
    const execution = bus.assert({ accessKey: 'read', agentId: 'a1', layers: [] })
    await Promise.resolve()
    assert.equal(asked.length, 1)
    const req = asked[0] as { id: string; accessKey: string; agentId: string }
    assert.equal(req.accessKey, 'read')
    assert.equal(req.agentId, 'a1')

    await bus.reply({ requestId: req.id, reply: 'once' }, 'user0')
    await execution
  })

  test('非根回复 → access_denied（授权校验）', async () => {
    const { bus } = makeBus()
    const execution = bus.assert({ accessKey: 'read', agentId: 'a1', layers: [] })
    await Promise.resolve()
    // 获取请求 id：从 bus 挂起列表取。
    const pending = bus.list()[0]
    assert.ok(pending)
    await assert.rejects(
      () => bus.reply({ requestId: pending!.id, reply: 'once' }, 'other-agent'),
      (e: unknown) => (e as { kind: string }).kind === 'access_denied',
    )
    // 挂起未被消费，仍可被根回复。
    await bus.reply({ requestId: pending!.id, reply: 'always' }, 'user0')
    await execution
  })

  test('reject → 带 feedback 抛 access_rejected', async () => {
    const { bus } = makeBus()
    const execution = bus.assert({ accessKey: 'bash', agentId: 'a2', layers: [] })
    await Promise.resolve()
    const pending = bus.list()[0]!
    await assert.rejects(
      () => execution,
      // 先回复 reject（根），execution 应被拒绝。
      (() => {
        void bus.reply({ requestId: pending.id, reply: 'reject', message: '不允许' }, 'user0')
        return (e: unknown) => (e as { kind: string }).kind === 'access_rejected'
      })(),
    )
  })

  test('autoApprove：ask 直接放行，不投递', async () => {
    const { asked } = makeBus()
    const bus = new DefaultAccessAskBus({
      askRoot: (req) => void asked.push(req),
      getRoot: () => 'user0',
      autoApprove: true,
    })
    await bus.assert({ accessKey: 'read', agentId: 'a1', layers: [] })
    assert.equal(asked.length, 0)
  })
})

describe('formatAccessRequest', () => {
  test('内容含 requestId/accessKey/agentId（供 access_reply 答复与 UI 解析）', () => {
    const text = formatAccessRequest({ id: 'r1', accessKey: 'read', agentId: 'a1', at: 0 })
    assert.ok(text.includes('<access_request id="r1" accessKey="read" agentId="a1">'))
    assert.ok(text.includes('requestId=r1'))
  })
})