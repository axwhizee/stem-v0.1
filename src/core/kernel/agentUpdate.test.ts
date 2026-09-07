// ============================================================
// core/kernel/agentUpdate.test.ts —— 实例参数统一更新通道单测
//
// kernel.updateAgent（agent_update 工具与 pilot 共用的唯一运行期写面）：
// 总序收敛校验（含藏匿=扩张被拒）/ 生效显式面基线（无能力清零悬崖）/
// grantTools 清单形整表替换 + 祖先显式封顶 / 收缩沿族谱下传重算 /
// canReach 授权 / 互斥与枚举校验 / 审计事件 / 模型半程不级联。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeGateway, textEvents } from '../gateway'
import { createKernelHarness } from '../../../test/support/kernelHarness'
import { USER_ID } from './Kernel'
import { makeAgentID, type AgentClass } from './types'
import { makeAgentClassID } from './types'

const userTools = {
  agent_instantiate: 'allow',
  agent_update: 'allow',
  agent_inspect: 'allow',
  bash: 'allow',
  read: 'allow',
  web: 'ask',
} as const

/** 继承形类（无 tools 键 = 完整继承父生效面）。 */
const inheritCls: AgentClass = {
  name: makeAgentClassID('inherit-form'),
  description: '继承形',
  systemPrompt: 'sys',
}
/** 自带封闭清单类。 */
const listedCls: AgentClass = {
  name: makeAgentClassID('listed'),
  description: '自带表',
  systemPrompt: 'sys',
  tools: { bash: 'allow', read: 'ask' },
}

async function harness() {
  const h = await createKernelHarness(new FakeGateway(() => textEvents('ok')), {
    userClass: { tools: userTools },
    templates: [inheritCls, listedCls],
  })
  await h.kernel.registerSystemTools(h.tools)
  return h
}

const as = (tools: Awaited<ReturnType<typeof harness>>['tools'], name: string, input: Record<string, unknown>) =>
  tools.execute({ id: `call_${name}`, name, input }, { agentId: USER_ID, spaceId: 'space-1' })
const asUser = (tools: Awaited<ReturnType<typeof harness>>['tools'], input: Record<string, unknown>) =>
  as(tools, 'agent_update', input)

describe('agent_update · tools 收敛 patch（总序）', () => {
  test('收紧生效：web ask→deny 落生效面与物化清单', async () => {
    const { kernel, tools } = await harness()
    const res = await asUser(tools, { agentId: 'user0', tools: { web: 'deny' } })
    // user0 根不可自改？——可见域含自身，改自己允许（root 平等原则）。
    assert.match(res.text, /已更新 user0/)
    assert.equal(kernel.lineage.effectiveAccess(USER_ID, 'web'), 'deny')
  })

  test('扩张与藏匿逐键拒绝（allow→ask 放宽拒；allow→ignore 藏匿拒）', async () => {
    const { kernel, tools } = await harness()
    await as(tools, 'agent_instantiate', { className: 'listed', userPrompt: 'hi', agentId: 'w1' })
    const bad = await asUser(tools, { agentId: 'w1', tools: { read: 'allow', bash: 'ignore' } })
    assert.match(bad.text, /扩张被拒/)
    assert.match(bad.text, /实例收敛被拒 read: allow（封顶 ask/)
    assert.match(bad.text, /实例收敛被拒 bash: ignore（封顶 allow/)
    // 整单拒绝不留半程副作用。
    assert.equal(kernel.lineage.effectiveAccess(makeAgentID('w1'), 'read'), 'ask')
    assert.equal(kernel.lineage.effectiveAccess(makeAgentID('w1'), 'bash'), 'allow')
  })

  test('继承形实例首更无悬崖：只动提及键，父档案键全保留', async () => {
    const { kernel, tools } = await harness()
    await as(tools, 'agent_instantiate', { className: 'inherit-form', userPrompt: 'hi', agentId: 'i1' })
    // 首更前生效面 = user0 全档案。
    assert.equal(kernel.lineage.effectiveAccess(makeAgentID('i1'), 'bash'), 'allow')
    assert.equal(kernel.lineage.effectiveAccess(makeAgentID('i1'), 'agent_instantiate'), 'allow')
    await asUser(tools, { agentId: 'i1', tools: { bash: 'deny' } })
    assert.equal(kernel.lineage.effectiveAccess(makeAgentID('i1'), 'bash'), 'deny')
    assert.equal(kernel.lineage.effectiveAccess(makeAgentID('i1'), 'agent_instantiate'), 'allow', '未被提及的继承键不得被封闭清零')
    assert.equal(kernel.lineage.effectiveAccess(makeAgentID('i1'), 'web'), 'ask', '根表 ask 摊平保留')
  })
})

describe('agent_update · grantTools 清单形（受限整表）', () => {
  test('未列一律 deny；给定即全部清单', async () => {
    const { kernel, tools } = await harness()
    await as(tools, 'agent_instantiate', { className: 'inherit-form', userPrompt: 'hi', agentId: 'g1' })
    await asUser(tools, { agentId: 'g1', grantTools: { read: 'allow' } })
    assert.equal(kernel.lineage.effectiveAccess(makeAgentID('g1'), 'read'), 'allow')
    assert.equal(kernel.lineage.effectiveAccess(makeAgentID('g1'), 'bash'), 'deny', '清单外 = 一律 deny（免逐个填表）')
    assert.equal(kernel.lineage.effectiveAccess(makeAgentID('g1'), 'agent_instantiate'), 'deny')
  })

  test('逐键封顶：祖先显式 ask 洗不成 allow；deny 铁律盖不过', async () => {
    const { kernel, tools } = await harness()
    await as(tools, 'agent_instantiate', { className: 'inherit-form', userPrompt: 'hi', agentId: 'g2' })
    // user0 根表 web:'ask'、bash:'allow'→先收敛 bash 出 deny 案例：用 web 封 ask。
    await asUser(tools, { agentId: 'g2', grantTools: { web: 'allow', bash: 'allow' } })
    assert.equal(kernel.lineage.effectiveAccess(makeAgentID('g2'), 'web'), 'ask', 'grant 过不了链上显式 ask 的顶')
    assert.equal(kernel.lineage.effectiveAccess(makeAgentID('g2'), 'bash'), 'allow')
    // 对 deny 祖先：先把根表 read 之外做一个 deny 链——mid 收敛 web deny，孙 grant 翻不动。
    await as(tools, 'agent_instantiate', { className: 'inherit-form', userPrompt: 'hi', agentId: 'mid' })
    await asUser(tools, { agentId: 'mid', tools: { web: 'deny' } })
    await kernel.instantiateInSpace(
      { className: makeAgentClassID('inherit-form'), parentId: makeAgentID('mid'), userPrompt: 'x' },
      'space-1',
    )
    const leaf = kernel.lineage.getChildren(makeAgentID('mid'))[0]
    assert.ok(leaf !== undefined)
    await asUser(tools, { agentId: leaf, grantTools: { web: 'allow' } })
    assert.equal(kernel.lineage.effectiveAccess(leaf, 'web'), 'deny', 'deny 铁律 = 封顶的最严特例，清单形不豁免')
  })

  test('tools 与 grantTools 互斥；非法枚举值拒绝', async () => {
    const { tools } = await harness()
    const mix = await asUser(tools, { agentId: 'user0', tools: { web: 'deny' }, grantTools: { read: 'allow' } })
    assert.match(mix.text, /互斥/)
    const junk = await asUser(tools, { agentId: 'user0', tools: { web: 'yes-please' } })
    assert.match(junk.text, /非法访问值/)
    const empty = await asUser(tools, { agentId: 'user0' })
    assert.match(empty.text, /至少给出一个/)
  })
})

describe('agent_update · 族谱级联与授权', () => {
  test('收缩沿链下传：mid ask→deny，孙的自身 allow 被新显式面压住（replay 重算）', async () => {
    const { kernel, tools } = await harness()
    await as(tools, 'agent_instantiate', { className: 'inherit-form', userPrompt: 'hi', agentId: 'm1' })
    // agent_instantiate 的父 = 调用者（user0）——手动挂到 m1 下：
    await kernel.instantiateInSpace({ className: makeAgentClassID('listed'), parentId: makeAgentID('m1'), userPrompt: 'x' }, 'space-1')
    const kids = kernel.lineage.getChildren(makeAgentID('m1'))
    const kid = kids[kids.length - 1]
    assert.ok(kid !== undefined)
    assert.equal(kernel.lineage.effectiveAccess(kid, 'read'), 'ask', '类表 ask × 继承 ask → ask')
    // m1 把 web 从根 ask 收紧……改 read 更直观：m1 生效 read=ask（继承根无 read? 根表 read allow）
    // 根表 read:'allow' → m1 生效 allow。m1 收紧 read→deny：孙 listed 类 read:'ask' → 物化压回 deny。
    await asUser(tools, { agentId: 'm1', tools: { read: 'deny' } })
    assert.equal(kernel.lineage.effectiveAccess(kid, 'read'), 'deny', '祖先后天收紧沿链下传（派生态重算）')
    assert.equal(kernel.lineage.effectiveAccess(makeAgentID('m1'), 'read'), 'deny')
  })

  test('兄弟不可改（canReach）；被拒无副作用', async () => {
    const { kernel, tools } = await harness()
    // 继承形类（agent_update 随根表 allow 继承）——s1 有工具可执行，但可见域不含兄弟。
    await as(tools, 'agent_instantiate', { className: 'inherit-form', userPrompt: 'hi', agentId: 's1' })
    await as(tools, 'agent_instantiate', { className: 'inherit-form', userPrompt: 'hi', agentId: 's2' })
    // s1 视角改 s2 → 无权。需以 s1 身份执行工具：
    const res = await tools.execute(
      { id: 'x', name: 'agent_update', input: { agentId: 's2', tools: { bash: 'deny' } } },
      { agentId: 's1', spaceId: 'space-1' },
    )
    assert.match(res.text, /无权/)
    assert.equal(kernel.lineage.effectiveAccess(makeAgentID('s2'), 'bash'), 'allow', '被拒不得留副作用')
  })

  test('模型半程经统一通道：显式层落行 + 审计双事件 + 子女快照不动', async () => {
    const { kernel, tools } = await harness()
    await as(tools, 'agent_instantiate', { className: 'inherit-form', userPrompt: 'hi', agentId: 'f1' })
    await kernel.instantiateInSpace({ className: makeAgentClassID('inherit-form'), parentId: makeAgentID('f1'), userPrompt: 'x' }, 'space-1')
    const child = kernel.lineage.getChildren(makeAgentID('f1'))[0]
    assert.ok(child !== undefined)
    const childSnapshot = kernel.instances.getSync(child)?.modelSnapshot
    assert.ok(childSnapshot !== undefined, '出生继承层子女必有快照（kernel attach 规则）')
    await asUser(tools, { agentId: 'f1', model: 'cfg/new-m', displayName: '甲' })
    assert.deepEqual(kernel.lineage.modelOf('f1'), { ref: { provider: 'cfg', id: 'new-m' }, origin: 'explicit' })
    assert.equal(kernel.instances.getSync(makeAgentID('f1'))?.displayName, '甲')
    assert.deepEqual(kernel.lineage.modelOf(child), childSnapshot, '改父不动子（快照保护）')
    const upd = kernel.logger.all().filter((e) => e.type === 'kernel.instance.updated')
    assert.equal(upd.length, 1)
    assert.ok(upd[0] !== undefined && upd[0].type === 'kernel.instance.updated')
    assert.deepEqual(upd[0].fields, ['model', 'displayName'])
    assert.equal(upd[0].by, USER_ID)
    assert.equal(kernel.logger.all().filter((e) => e.type === 'kernel.model.set').length, 1, 'model 半程保留既有事件')
  })
})
