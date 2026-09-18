// ============================================================
// core/kernel/telemetry.test.ts —— 进化观测面单测（telemetry_query）
//
// 核心契约：可见域 = 树位置函数（自身 ∪ 祖先代查：后代可查、
// 兄弟不可见、根天然全视）；行式压缩；类型/时间过滤；limit 截尾。
// 断言面用出生路径 id（B1）与 `name#id` 呈现（B3）。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeGateway, textEvents } from '../gateway'
import { createKernelHarness } from '../../../test/support/kernelHarness'
import { makeAgentClassID, ROOT_ID } from './types'
import type { LogEvent } from '../logging'

/** 构造根 → {A→A1, B} 三叉谱系（observer 类显式声明观测面）并注入混合事件。 */
async function setup() {
  const { kernel, tools } = await createKernelHarness(new FakeGateway(() => textEvents('ok')))
  // 观测者类：telemetry_query 显式 allow（internal registerAccess ignore = 不暴露）。
  await kernel.templates.register({
    name: makeAgentClassID('observer'),
    description: '观察者',
    systemPrompt: 'watch',
    tools: { telemetry_query: 'allow' },
  })
  const A = await kernel.instantiateAgent({ className: makeAgentClassID('observer'), parentId: ROOT_ID, userPrompt: 'x' })
  const A1 = await kernel.instantiateAgent({ className: makeAgentClassID('observer'), parentId: A, userPrompt: 'x' })
  const B = await kernel.instantiateAgent({ className: makeAgentClassID('observer'), parentId: ROOT_ID, userPrompt: 'x' })
  assert.equal(A, '1')
  assert.equal(A1, '1.1')
  assert.equal(B, '2')
  const ev = (e: LogEvent) => kernel.logger.log(e)
  const t = 1000
  ev({ type: 'tool.invoked', at: t, agentId: A, tool: 'read', args: {}, phase: 'success', durationMs: 5 })
  ev({ type: 'tool.invoked', at: t + 1, agentId: B, tool: 'bash', args: {}, phase: 'called' })
  ev({ type: 'gateway.apiRequest', at: t + 2, agentId: A1, model: 'm', provider: 'p', latencyMs: 10, cost: 0.001 })
  ev({ type: 'access.asked', at: t + 3, agentId: A, accessKey: 'edit', action: 'ask' })
  ev({ type: 'context.compacted', at: t + 4, agentId: 'USER', outcome: 'skipped', compactedCount: 0, message: '-' })
  const run = (agentId: string, input: Record<string, unknown>) =>
    tools.execute({ id: 'tq', name: 'telemetry_query', input }, { agentId })
  return { kernel, tools, run, t, A, A1, B }
}

describe('telemetry_query（可见域 = 树位置函数）', () => {
  test('缺省查自身：只含牵涉本 agent 的事件行；header 呈现全名', async () => {
    const { kernel, run, A } = await setup()
    const out = await run(A, {})
    assert.ok(out.text.startsWith(`${kernel.displayOf(A)} |`), out.text.slice(0, 80))
    assert.match(out.text, /\d+ 条/)
    assert.match(out.text, /\| tool\.invoked \| read success 5ms/)
    assert.match(out.text, /\| access\.asked \| edit ask/)
    assert.ok(!out.text.includes('bash called'), 'B 的事件不混入')
    assert.ok(!out.text.includes('cost=0.0010'), 'A1 的手注事件默认不并入（缺省 = 仅自身）')
  })

  test('后代可查（祖先代查）；兄弟不可见；根天然全视', async () => {
    const { run, A, A1, B } = await setup()
    const desc = await run(A, { agentId: A1 })
    assert.match(desc.text, /\| gateway\.apiRequest \| p\/m tok=-\/- cost=0\.0010 10ms/)
    const sibling = await run(A, { agentId: B })
    assert.match(sibling.text, /无权查看/)
    const rootB = await run(ROOT_ID, { agentId: B })
    assert.match(rootB.text, /\| tool\.invoked \| bash called/)
    const childUp = await run(A1, { agentId: ROOT_ID })
    assert.match(childUp.text, /无权查看/, '后代向上看 = 不可见（可见域单向）')
  })

  test('寻址三形态走通：agentId 参可用 name（B3 写面）', async () => {
    const { kernel, run, A, B } = await setup()
    const byName = await run(ROOT_ID, { agentId: 'observer-3', types: ['tool.invoked'] }) // B 的派生名
    assert.match(byName.text, /bash called/)
    assert.ok(byName.text.startsWith(`${kernel.displayOf(B)} |`), byName.text.slice(0, 80))
    const selfByName = await run(A, {})
    assert.ok(selfByName.text.startsWith('observer-1#1 |'), selfByName.text.slice(0, 80))
  })

  test('类型过滤（精确 + 前缀通配）与时间窗', async () => {
    const { run, t, A } = await setup()
    const typed = await run(A, { types: ['tool.*'] })
    assert.equal(typed.text.split('\n').filter((l) => /^\d{2}:\d{2}/.test(l)).length, 2, '两条数据行（read success + 本次查询自身 called）')
    const exact = await run(A, { types: ['access.asked'] })
    assert.match(exact.text, /access\.asked/)
    assert.ok(!exact.text.includes('tool.invoked'))
    const windowed = await run(A, { since: t + 3 })
    assert.match(windowed.text, /access\.asked/)
    assert.ok(!windowed.text.includes('read success'), 'since 之前被裁')
  })

  test('limit 取最近 N 条并报告总匹配数；空结果显式 (no events)', async () => {
    const { kernel, run, A1, B } = await setup()
    for (let i = 0; i < 5; i++) {
      kernel.logger.log({ type: 'mailbox.countdown', at: 5000 + i, agentId: B, action: i % 2 === 0 ? 'start' : 'fire' })
    }
    const limited = await run(ROOT_ID, { agentId: B, types: ['mailbox.countdown'], until: 6000, limit: 2 })
    assert.match(limited.text, /2 条（最近 2 条，共匹配 5）/)
    assert.ok(!limited.text.includes('00:00:05.001'), '最早几条被裁（时间列 = ISO 毫秒段）')
    const empty = await run(A1, { types: ['nonexistent.*'] })
    assert.equal(empty.text, '(no events)')
  })

  test('封闭清单类的 agent 够不到观测面（registerAccess ignore + 白名单封闭）', async () => {
    const { kernel, tools } = await setup()
    await kernel.templates.register({ name: makeAgentClassID('closed'), description: 'closed', systemPrompt: 's', tools: {} })
    const closed = await kernel.getOrCreateAgent(makeAgentClassID('closed'), '/other')
    await assert.rejects(
      () => tools.execute({ id: 'tq2', name: 'telemetry_query', input: {} }, { agentId: closed }),
      (e: unknown) => (e as { kind: string }).kind === 'access_denied',
    )
  })

  test('根清单 allow（评估者开箱可用）；实例创建等真实事件也在流里', async () => {
    const { run, A } = await setup()
    const out = await run(ROOT_ID, { agentId: A, types: ['kernel.instance.created'] })
    assert.match(out.text, /class=observer parent=0/)
  })
})
