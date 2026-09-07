// ============================================================
// core/kernel/modelTools.test.ts —— S6 模型工具面单测
//
// agent_instantiate.model（出生显式层）/ agent_update（R7：
// 授权 = canReach、internal 缺省 ignore、审计与遥测）/ agent_inspect
// 的模型谱系（R6 四级律 origin 出示）。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeGateway, textEvents } from '../gateway'
import { createKernelHarness } from '../../../test/support/kernelHarness'
import { formatTelemetryRow } from './systemTools'
import { USER_ID } from './Kernel'
import { makeAgentClassID, makeAgentID, type AgentClass } from './types'

const userTools = {
  agent_instantiate: 'allow',
  // R7 缺省形态 = ignore（背景在场、可执行不设防）；根与自理类同取 ignore
  // （新收敛链下，子若声明 ignore 而父为 allow 属藏匿扩张会被拒——这里两层级一致）。
  agent_update: 'ignore',
  agent_inspect: 'allow',
  agent_list: 'allow',
} as const

/** 自理模型类：agent_update 显式 ignore（不暴露但可执行，R7 缺省形态的用户位）。 */
const selfModelCls: AgentClass = {
  name: makeAgentClassID('self-model'),
  description: '可自换模型',
  systemPrompt: 'sys',
  tools: { agent_update: 'ignore' },
}
/** 带类基因模型。 */
const genedCls: AgentClass = {
  name: makeAgentClassID('gened'),
  description: '类基因',
  systemPrompt: 'sys',
  tools: {},
  model: { provider: 'cfg', id: 'class-m' },
}

async function harness() {
  const h = await createKernelHarness(new FakeGateway(() => textEvents('ok')), {
    userClass: { tools: userTools },
    templates: [selfModelCls, genedCls],
  })
  await h.kernel.registerSystemTools(h.tools)
  return h
}

const asUser = (tools: Awaited<ReturnType<typeof harness>>['tools'], name: string, input: Record<string, unknown>) =>
  tools.execute({ id: `call_${name}`, name, input }, { agentId: USER_ID, spaceId: 'space-1' })

describe('agent_instantiate 显式模型（R6 出生链顶）', () => {
  test('model 参 → 实例行 + 树绑定 explicit；非法格式回 usage 提示且不创建', async () => {
    const { kernel, tools } = await harness()
    const result = await asUser(tools, 'agent_instantiate', {
      className: 'self-model',
      userPrompt: 'hi',
      agentId: 'e1',
      model: 'cfg/explicit-m',
    })
    assert.match(result.text, /已创建 agent e1/)
    assert.deepEqual(kernel.instances.getSync(makeAgentID('e1'))?.model, { provider: 'cfg', id: 'explicit-m' })
    assert.deepEqual(kernel.lineage.modelOf('e1'), { ref: { provider: 'cfg', id: 'explicit-m' }, origin: 'explicit' })

    const bad = await asUser(tools, 'agent_instantiate', { className: 'self-model', userPrompt: 'hi', agentId: 'e2', model: 'bare-name' })
    assert.match(bad.text, /提供商\/模型/)
    assert.equal(kernel.instances.getSync(makeAgentID('e2')), undefined, '非法格式不得创建实例')
  })

  test('缺省不显式 → 类基因层 / 无基因落家学（home 传播）', async () => {
    const { kernel, tools } = await harness()
    await asUser(tools, 'agent_instantiate', { className: 'gened', userPrompt: 'hi', agentId: 'g1' })
    assert.deepEqual(kernel.lineage.modelOf('g1'), { ref: { provider: 'cfg', id: 'class-m' }, origin: 'class' })
    await asUser(tools, 'agent_instantiate', { className: 'self-model', userPrompt: 'hi', agentId: 's1' })
    assert.deepEqual(kernel.lineage.modelOf('s1'), { ref: { provider: 'fake', id: 'home-model' }, origin: 'home' })
  })
})

describe('agent_update（R7）', () => {
  test('自身通道：ignore 声明类可自换；不级联兄弟与子女（canReach + 出生快照）', async () => {
    const { kernel, tools } = await harness()
    await asUser(tools, 'agent_instantiate', { className: 'self-model', userPrompt: 'hi', agentId: 'p1' })
    const p1 = makeAgentID('p1')
    // 兄弟（同为 user0 直接子）
    await asUser(tools, 'agent_instantiate', { className: 'self-model', userPrompt: 'hi', agentId: 'q1' })
    // p1 名下子女（出生快照 = p1 当时值）
    await kernel.instantiateInSpace({ className: makeAgentClassID('self-model'), parentId: p1, userPrompt: 'child' }, 'space-1')

    // p1 自换模型（ignore = 隐藏但可执行，无 ask 弹窗直落）
    const self = await tools.execute(
      { id: 'call_self', name: 'agent_update', input: { model: 'cfg/new-m' } },
      { agentId: 'p1', spaceId: 'space-1' },
    )
    assert.match(self.text, /已更新 p1/)
    assert.deepEqual(kernel.lineage.modelOf('p1'), { ref: { provider: 'cfg', id: 'new-m' }, origin: 'explicit' })
    assert.deepEqual(kernel.instances.getSync(p1)?.model, { provider: 'cfg', id: 'new-m' })
    // 子女快照不动
    const childId = kernel.lineage.getChildren(p1)[0]
    assert.ok(childId !== undefined)
    assert.deepEqual(kernel.lineage.modelOf(childId)?.ref, { provider: 'fake', id: 'home-model' }, '改父不动子')
    // 兄弟互不可见：q1 改 p1 → 拒绝文案
    const deny = await tools.execute(
      { id: 'call_deny', name: 'agent_update', input: { agentId: 'p1', model: 'cfg/evil' } },
      { agentId: 'q1', spaceId: 'space-1' },
    )
    assert.match(deny.text, /无权/)
    assert.deepEqual(kernel.lineage.modelOf('p1')?.ref, { provider: 'cfg', id: 'new-m' }, '被拒不得留副作用')
    // 非法格式
    const bad = await tools.execute(
      { id: 'call_bad', name: 'agent_update', input: { model: 'nope' } },
      { agentId: 'p1', spaceId: 'space-1' },
    )
    assert.match(bad.text, /提供商\/模型/)
  })

  test('审计事件 kernel.model.set 入账且遥测行式可读（by 归属）', async () => {
    const { kernel, tools } = await harness()
    await asUser(tools, 'agent_instantiate', { className: 'self-model', userPrompt: 'hi', agentId: 't1' })
    await asUser(tools, 'agent_update', { agentId: 't1', model: 'cfg/m2' })
    const rows = kernel.logger.all().filter((event) => event.type === 'kernel.model.set')
    assert.equal(rows.length, 1)
    const setEvent = rows[0]
    assert.ok(setEvent !== undefined && setEvent.type === 'kernel.model.set')
    assert.equal(setEvent.agentId, 't1')
    assert.equal(setEvent.by, USER_ID, 'user0 通道审计归属')
    assert.match(formatTelemetryRow(setEvent), /model→cfg\/m2 by=user0/)
  })
})

describe('agent_inspect 模型谱系（R6 origin 出示）', () => {
  test('家学 / 类基因 / 实例显式三态标签', async () => {
    const { tools } = await harness()
    const rootText = (await asUser(tools, 'agent_inspect', { agentId: USER_ID })).text
    assert.match(rootText, /model: fake\/home-model（家学 = config\.user\.model）/)
    await asUser(tools, 'agent_instantiate', { className: 'gened', userPrompt: 'hi', agentId: 'g9' })
    assert.match((await asUser(tools, 'agent_inspect', { agentId: 'g9' })).text, /cfg\/class-m（类基因）/)
    await asUser(tools, 'agent_instantiate', { className: 'gened', userPrompt: 'hi', agentId: 'x9', model: 'cfg/x-m' })
    const text = (await asUser(tools, 'agent_inspect', { agentId: 'x9' })).text
    assert.match(text, /cfg\/x-m（实例显式/)
    assert.doesNotMatch(text, /cfg\/class-m/, '显式遮蔽类基因')
  })
})
