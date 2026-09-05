// ============================================================
// core/tools/accessRequest.test.ts —— ask 消息化总线单测
//
// 覆盖：族谱查询（AccessResolver 注入）+ 四态分流 + 根授权校验 +
// per-agent ask 豁免备忘（always 免询问、agent 隔离、不破 deny/ignore）。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DefaultAccessAskBus, formatAccessRequest } from './accessRequest'
import type { AccessResolver, ToolAccess } from './types'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** 固定判定表 resolver（模拟族谱台账；缺席 = undefined → defaultAccess）。 */
const tableResolver = (table: Record<string, ToolAccess | undefined>): AccessResolver => ({
  accessOf: (agentId, key) => table[`${agentId}/${key}`],
})

const makeBus = (opts: { resolve?: AccessResolver; autoApprove?: boolean } = {}) => {
  const asked: unknown[] = []
  const bus = new DefaultAccessAskBus({
    askRoot: (req) => void asked.push(req),
    getRoot: () => 'user0',
    ...(opts.resolve !== undefined ? { resolve: opts.resolve } : {}),
    ...(opts.autoApprove !== undefined ? { autoApprove: opts.autoApprove } : {}),
  })
  return { bus, asked }
}

describe('DefaultAccessAskBus（ask 消息化 + 族谱查询）', () => {
  test('resolver 判定 allow/ignore → 直接放行，不投递', async () => {
    const { bus, asked } = makeBus({
      resolve: tableResolver({ 'a1/read': 'allow', 'a1/skill': 'ignore' }),
    })
    await bus.assert({ accessKey: 'read', agentId: 'a1' })
    await bus.assert({ accessKey: 'skill', agentId: 'a1', defaultAccess: 'ignore' })
    assert.equal(asked.length, 0)
  })

  test('resolver 判定 deny → access_denied（不弹窗）', async () => {
    const { bus, asked } = makeBus({ resolve: tableResolver({ 'a1/bash': 'deny' }) })
    await assert.rejects(
      () => bus.assert({ accessKey: 'bash', agentId: 'a1' }),
      (e: unknown) => (e as { kind: string }).kind === 'access_denied',
    )
    assert.equal(asked.length, 0)
  })

  test('ask → 投递申请到根信箱（askRoot 收到带 id 的请求）→ once 解析', async () => {
    const { bus, asked } = makeBus({ resolve: tableResolver({ 'a1/read': 'ask' }) })
    const execution = bus.assert({ accessKey: 'read', agentId: 'a1' })
    await tick()
    assert.equal(asked.length, 1)
    const req = asked[0] as { id: string; accessKey: string; agentId: string }
    assert.equal(req.accessKey, 'read')
    assert.equal(req.agentId, 'a1')

    await bus.reply({ requestId: req.id, reply: 'once' }, 'user0')
    await execution
  })

  test('总序复核：挂起期间该键被收敛为 deny——迟到的 always 被铁律压死且不写豁免', async () => {
    // 模拟 agent_update 在途改严：resolver 读活表（同一台账查询端口，零新依赖）。
    const table: Record<string, ToolAccess | undefined> = { 'a1/read': 'ask' }
    const { bus, asked } = makeBus({ resolve: tableResolver(table) })
    const execution = bus.assert({ accessKey: 'read', agentId: 'a1' })
    await tick()
    assert.equal(asked.length, 1)
    const req = asked[0] as { id: string }
    table['a1/read'] = 'deny' // 根在答复前经 agent_update 把该键收严
    await bus.reply({ requestId: req.id, reply: 'always' }, 'user0')
    await assert.rejects(execution, (e: unknown) => (e as { kind?: string }).kind === 'access_rejected')
    assert.deepEqual(bus.listApprovals(), [], 'deny 复核的拒绝不得留下 always 豁免备忘')
  })

  test('族谱无判定 → 落 defaultAccess（internal ignore 放行 / 缺省 ask）', async () => {
    const { bus, asked } = makeBus()
    await bus.assert({ accessKey: 'agent_list', agentId: 'a1', defaultAccess: 'ignore' })
    assert.equal(asked.length, 0, 'internal 默认 ignore：无人声明 = 隐藏但放行')

    const execution = bus.assert({ accessKey: 'bash', agentId: 'a1' })
    await tick()
    assert.equal(asked.length, 1, '无判定无默认 → ask')
    const pending = bus.list()[0]!
    await bus.reply({ requestId: pending.id, reply: 'once' }, 'user0')
    await execution
  })

  test('非根回复 → access_reply_not_root（行动化文案），挂起仍可被根回复', async () => {
    const { bus } = makeBus({ resolve: tableResolver({ 'a1/read': 'ask' }) })
    const execution = bus.assert({ accessKey: 'read', agentId: 'a1' })
    await tick()
    const pending = bus.list()[0]
    assert.ok(pending)
    await assert.rejects(
      () => bus.reply({ requestId: pending!.id, reply: 'once' }, 'other-agent'),
      (e: unknown) => (e as { kind: string }).kind === 'access_reply_not_root',
    )
    await bus.reply({ requestId: pending!.id, reply: 'always' }, 'user0')
    await execution
  })

  test('reject → 带 feedback 抛 access_rejected', async () => {
    const { bus } = makeBus({ resolve: tableResolver({ 'a2/bash': 'ask' }) })
    const execution = bus.assert({ accessKey: 'bash', agentId: 'a2' })
    await tick()
    const pending = bus.list()[0]!
    void bus.reply({ requestId: pending.id, reply: 'reject', message: '不允许' }, 'user0')
    await assert.rejects(
      () => execution,
      (e: unknown) => {
        const err = e as { kind: string; feedback?: string }
        return err.kind === 'access_rejected' && err.feedback === '不允许'
      },
    )
  })

  test('autoApprove：ask 直接放行，不投递', async () => {
    const { bus, asked } = makeBus({
      resolve: tableResolver({ 'a1/read': 'ask' }),
      autoApprove: true,
    })
    await bus.assert({ accessKey: 'read', agentId: 'a1' })
    assert.equal(asked.length, 0)
  })

  test('always 豁免备忘：同 agent 同键不再弹窗（ask 升级静默放行）', async () => {
    const { bus, asked } = makeBus({ resolve: tableResolver({ 'a1/read': 'ask' }) })
    const first = bus.assert({ accessKey: 'read', agentId: 'a1' })
    await tick()
    assert.equal(asked.length, 1)
    await bus.reply({ requestId: bus.list()[0]!.id, reply: 'always' }, 'user0')
    await first

    // 第二次：不再产生申请（旧缺陷：allow 规则参与分层取严，ask 永远压不掉）。
    await bus.assert({ accessKey: 'read', agentId: 'a1' })
    assert.equal(asked.length, 1)
    assert.deepEqual(bus.listApprovals(), [{ agentId: 'a1', accessKey: 'read' }])
  })

  test('always 豁免按 agent 隔离：不泄漏到其他实例（旧缺陷回归）', async () => {
    const { bus, asked } = makeBus({
      resolve: tableResolver({ 'a1/read': 'ask', 'a2/read': 'ask' }),
    })
    const first = bus.assert({ accessKey: 'read', agentId: 'a1' })
    await tick()
    await bus.reply({ requestId: bus.list()[0]!.id, reply: 'always' }, 'user0')
    await first

    // a2 首次使用 read：仍须询问。
    const second = bus.assert({ accessKey: 'read', agentId: 'a2' })
    await tick()
    assert.equal(asked.length, 2)
    await bus.reply({ requestId: bus.list()[0]!.id, reply: 'once' }, 'user0')
    await second
  })

  test('豁免不越权：deny/ignore 判定不受备忘影响', async () => {
    const { bus } = makeBus({
      resolve: tableResolver({ 'a1/bash': 'deny', 'a1/edit': 'ask' }),
    })
    // 先拿到 edit 的 always 豁免。
    const askPass = bus.assert({ accessKey: 'edit', agentId: 'a1' })
    await tick()
    await bus.reply({ requestId: bus.list()[0]!.id, reply: 'always' }, 'user0')
    await askPass

    await assert.rejects(
      () => bus.assert({ accessKey: 'bash', agentId: 'a1' }),
      (e: unknown) => (e as { kind: string }).kind === 'access_denied',
    )
  })
})

describe('formatAccessRequest', () => {
  test('内容含 requestId/accessKey/agentId（供 access_reply 答复与 UI 解析）', () => {
    const text = formatAccessRequest({ id: 'r1', accessKey: 'read', agentId: 'a1', at: 0 })
    assert.ok(text.includes('<access_request id="r1" accessKey="read" agentId="a1">'))
    assert.ok(text.includes('requestId=r1'))
  })
})
