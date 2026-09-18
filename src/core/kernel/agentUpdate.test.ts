// ============================================================
// core/kernel/agentUpdate.test.ts —— 实例参数统一更新通道单测
//
// kernel.updateAgent（agent_update 工具与 pilot 共用的唯一运行期写面）：
// 可写面 = name / model；tools 出生后不可改（属性表律）。
// canReach 授权 / 模型不级联 / 审计事件。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeGateway, textEvents } from '../gateway'
import { createKernelHarness } from '../../../test/support/kernelHarness'

import { ROOT_ID, type AgentClass } from './types'
import { makeAgentClassID } from './types'

const userTools = {
  agent_instantiate: 'allow',
  agent_update: 'allow',
  agent_inspect: 'allow',
  bash: 'allow',
} as const

const inheritCls: AgentClass = {
  name: makeAgentClassID('inherit-form'),
  description: '继承形',
  systemPrompt: 'sys',
}

async function harness() {
  const h = await createKernelHarness(new FakeGateway(() => textEvents('ok')), {
    userClass: { tools: userTools },
    templates: [inheritCls],
  })
  return h
}

const as = (tools: Awaited<ReturnType<typeof harness>>['tools'], name: string, input: Record<string, unknown>) =>
  tools.execute({ id: `call_${name}`, name, input }, { agentId: ROOT_ID })
const asUser = (tools: Awaited<ReturnType<typeof harness>>['tools'], input: Record<string, unknown>) =>
  as(tools, 'agent_update', input)

describe('agent_update · name / model', () => {
  test('改名与改模型走统一通道', async () => {
    const { kernel, tools } = await harness()
    const res = await asUser(tools, { agentId: 'user', model: 'cfg/new-m', name: '甲' })
    assert.match(res.text, /已更新 甲#0/)
    assert.deepEqual(kernel.lineage.modelOf(ROOT_ID), { ref: { provider: 'cfg', id: 'new-m' }, origin: 'explicit' })
    assert.equal(kernel.instances.getSync(ROOT_ID)?.name, '甲')
  })

  test('兄弟不可改（canReach）；被拒无副作用', async () => {
    const { kernel, tools } = await harness()
    await as(tools, 'agent_instantiate', { className: 'inherit-form', userPrompt: 'hi', name: 's1' })
    await as(tools, 'agent_instantiate', { className: 'inherit-form', userPrompt: 'hi', name: 's2' })
    const res = await tools.execute(
      { id: 'x', name: 'agent_update', input: { agentId: 's2', name: 'hack' } },
      { agentId: kernel.resolveAgent('s1') },
    )
    assert.match(res.text, /无权/)
    assert.equal(kernel.instances.getSync(kernel.resolveAgent('s2'))?.name, 's2')
  })

  test('改父不动子（出生落地绑定保护）', async () => {
    const { kernel, tools } = await harness()
    await as(tools, 'agent_instantiate', { className: 'inherit-form', userPrompt: 'hi', name: 'f1' })
    const f1 = kernel.resolveAgent('f1')
    await kernel.instantiateInSpace({ className: makeAgentClassID('inherit-form'), parentId: f1, userPrompt: 'x' })
    const child = kernel.lineage.getChildren(f1)[0]
    assert.ok(child !== undefined)
    const childBinding = kernel.instances.getSync(child)?.modelBinding
    assert.ok(childBinding !== undefined, '出生继承层子女必有落地绑定')
    await asUser(tools, { agentId: 'f1', model: 'cfg/new-m' })
    assert.deepEqual(kernel.lineage.modelOf(f1), { ref: { provider: 'cfg', id: 'new-m' }, origin: 'explicit' })
    assert.deepEqual(kernel.lineage.modelOf(child), childBinding, '改父不动子')
  })

  test('审计事件：instance.updated + model.set', async () => {
    const { kernel, tools } = await harness()
    await asUser(tools, { agentId: 'user', model: 'cfg/hot' })
    const upd = kernel.logger.all().filter((e) => e.type === 'kernel.instance.updated')
    assert.equal(upd.length, 1)
    assert.ok(upd[0] !== undefined && upd[0].type === 'kernel.instance.updated')
    assert.deepEqual(upd[0].fields, ['model'])
    assert.equal(kernel.logger.all().filter((e) => e.type === 'kernel.model.set').length, 1)
  })

  test('空 patch 指路；tools 参数已退役', async () => {
    const { tools } = await harness()
    const empty = await asUser(tools, { agentId: 'user' })
    assert.match(empty.text, /至少给出一个/)
    const toolsArg = await asUser(tools, { agentId: 'user', tools: { bash: 'deny' } })
    assert.match(toolsArg.text, /至少给出一个/, 'tools 不再是合法更新字段')
  })
})
