// ============================================================
// core/kernel/classEvolution.test.ts —— 进化书写面单测（S5.2）
//
// agent_class_create 落盘改造 + agent_class_update（收敛校验矩阵 /
// panel 与 user 根类红线 / 边界：更新只影响后续实例）。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeGateway, textEvents } from '../gateway'
import { createKernelHarness } from '../../../test-support/kernelHarness'
import { checkToolsConvergence } from './systemTools'
import { USER_ID } from './Kernel'
import { makeAgentClassID, makeAgentID, type AgentClass } from './types'

function harnessWithStore() {
  const saved: AgentClass[] = []
  return {
    saved,
    classStore: { save: async (cls: AgentClass) => { saved.push(cls) } },
  }
}

const userTools = {
  agent_class_create: 'allow',
  agent_class_update: 'allow',
  agent_instantiate: 'allow',
  agent_list: 'allow',
} as const

/** 走工具通道创建类（user0 身份）。 */
async function createViaTool(tools: Awaited<ReturnType<typeof createKernelHarness>>['tools'], input: Record<string, unknown>) {
  return tools.execute({ id: 'call_create', name: 'agent_class_create', input }, { agentId: USER_ID, spaceId: 'space-1' })
}

async function updateViaTool(tools: Awaited<ReturnType<typeof createKernelHarness>>['tools'], input: Record<string, unknown>) {
  return tools.execute({ id: 'call_update', name: 'agent_class_update', input }, { agentId: USER_ID, spaceId: 'space-1' })
}

describe('checkToolsConvergence（纯校验矩阵：序不升 + deny 铁律）', () => {
  const cur: Readonly<Record<string, 'allow' | 'ask' | 'deny' | 'ignore'>> = {
    a: 'allow',
    b: 'ask',
    c: 'deny',
    d: 'ignore',
  }
  test('allow 收敛到 ask/deny/ignore 全放行（含同级可见性自决）', () => {
    assert.deepEqual(checkToolsConvergence(cur, { a: 'ask' }), [])
    assert.deepEqual(checkToolsConvergence(cur, { a: 'deny' }), [])
    assert.deepEqual(checkToolsConvergence(cur, { a: 'ignore' }), [])
  })
  test('ask 不得升为 allow/ignore（不可移除人审闸），只可降 deny', () => {
    assert.equal(checkToolsConvergence(cur, { b: 'allow' }).length, 1)
    assert.equal(checkToolsConvergence(cur, { b: 'ignore' }).length, 1)
    assert.deepEqual(checkToolsConvergence(cur, { b: 'deny' }), [])
  })
  test('deny 是不可撤销铁律：任何变更被拒', () => {
    for (const next of ['allow', 'ask', 'ignore'] as const) {
      assert.equal(checkToolsConvergence(cur, { c: next }).length, 1, `deny→${next} 必须被拒`)
    }
  })
  test('ignore 同级回 allow 放行（可见性自决），升不出更强执行面', () => {
    assert.deepEqual(checkToolsConvergence(cur, { d: 'allow' }), [])
    assert.equal(checkToolsConvergence(cur, { d: 'ask' }).length, 0, 'ignore→ask：执行面收敛（加人审闸）')
    assert.deepEqual(checkToolsConvergence(cur, { d: 'deny' }), [])
  })
  test('新键放行（键即白名单=自我限定；实际能力由台账收敛兜底）', () => {
    assert.deepEqual(checkToolsConvergence(cur, { brand_new: 'allow' }), [])
  })
  test('多违规逐条报告', () => {
    const errs = checkToolsConvergence(cur, { b: 'allow', c: 'allow' })
    assert.equal(errs.length, 2)
  })
})

describe('agent_class_create：注册 + 落盘（S5.2）', () => {
  test('注入 classStore → 创建即回写（persisted 文案），saved 收到完整类', async () => {
    const store = harnessWithStore()
    const { kernel, tools } = await createKernelHarness(new FakeGateway(() => textEvents('ok')), {
      userClass: { tools: userTools },
      classStore: store.classStore,
    })
    await kernel.registerSystemTools(tools)
    const result = await createViaTool(tools, {
      name: 'reviewer',
      description: '代码审查',
      systemPrompt: 'You review code.',
      tools: { read: 'allow' },
    })
    assert.match(result.text, /已落盘/)
    assert.equal(store.saved.length, 1)
    assert.equal(store.saved[0]!.name, 'reviewer')
    assert.deepEqual(store.saved[0]!.tools, { read: 'allow' })
    // 审计事件带 persisted 标记。
    const ev = kernel.logger.query({ type: 'kernel.class.registered' }).at(-1)
    assert.deepEqual({ classId: (ev as { classId: string }).classId, persisted: (ev as { persisted?: boolean }).persisted }, { classId: 'reviewer', persisted: true })
  })

  test('无 classStore → 纯内存注册（试验田语义），文案区分', async () => {
    const { kernel, tools } = await createKernelHarness(new FakeGateway(() => textEvents('ok')), {
      userClass: { tools: userTools },
    })
    await kernel.registerSystemTools(tools)
    const result = await createViaTool(tools, { name: 'lab', description: 'd', systemPrompt: 'p', tools: {} })
    assert.match(result.text, /仅内存注册/)
    assert.ok(kernel.templates.getSync(makeAgentClassID('lab')))
  })

  test('同名创建被拒（模板注册表查重 = 变体必须新名并存）', async () => {
    const { kernel, tools } = await createKernelHarness(new FakeGateway(() => textEvents('ok')), {
      userClass: { tools: userTools },
    })
    await kernel.registerSystemTools(tools)
    await createViaTool(tools, { name: 'dup', description: 'd', systemPrompt: 'p' })
    await assert.rejects(
      () => createViaTool(tools, { name: 'dup', description: 'd2', systemPrompt: 'p2' }),
      (e: unknown) => (e as { kind: string }).kind === 'template_exists',
    )
  })
})

describe('agent_class_update：同名覆盖 + 落盘 + 只许收敛', () => {
  test('合法收敛：工具降档 + systemPrompt/model 更新，合并类落盘且注册表同步', async () => {
    const store = harnessWithStore()
    const { kernel, tools } = await createKernelHarness(new FakeGateway(() => textEvents('ok')), {
      userClass: { tools: userTools },
      classStore: store.classStore,
    })
    await kernel.registerSystemTools(tools)
    await createViaTool(tools, { name: 'reviewer', description: 'v1', systemPrompt: 'p1', tools: { read: 'allow', bash: 'ask' } })
    const result = await updateViaTool(tools, { name: 'reviewer', systemPrompt: 'p2', tools: { read: 'deny', bash: 'deny' }, model: 'prov/m1' })
    assert.match(result.text, /已更新类 reviewer/)
    assert.match(result.text, /已落盘/)
    assert.match(result.text, /对后续实例生效/)
    const cls = kernel.templates.getSync(makeAgentClassID('reviewer'))!
    assert.equal(cls.systemPrompt, 'p2')
    assert.deepEqual(cls.tools, { read: 'deny', bash: 'deny' })
    assert.deepEqual(cls.model, { provider: 'prov', id: 'm1' })
    assert.equal(cls.description, 'v1', '未 patch 字段保留')
    assert.equal(store.saved.length, 2, 'create + update 各落盘一次')
    assert.deepEqual(store.saved[1]!.tools, { read: 'deny', bash: 'deny' })
    // 审计事件：kernel.class.updated（patch 键清单 + persisted）。
    const ev = kernel.logger.query({ type: 'kernel.class.updated' }).at(-1) as { patch: string; persisted: boolean } | undefined
    assert.ok(ev && ev.persisted && ev.patch.split(',').includes('systemPrompt'))
  })

  test('扩张 patch 整单拒绝（注册表与磁盘都不动）', async () => {
    const store = harnessWithStore()
    const { kernel, tools } = await createKernelHarness(new FakeGateway(() => textEvents('ok')), {
      userClass: { tools: userTools },
      classStore: store.classStore,
    })
    await kernel.registerSystemTools(tools)
    await createViaTool(tools, { name: 'gated', description: 'd', systemPrompt: 'p', tools: { bash: 'ask' } })
    const before = store.saved.length
    const result = await updateViaTool(tools, { name: 'gated', tools: { bash: 'allow' }, systemPrompt: 'sneak' })
    assert.match(result.text, /只能收敛/)
    assert.match(result.text, /bash: ask → allow（扩张被拒）/)
    assert.equal(store.saved.length, before, '违规 → 零落盘')
    assert.equal(kernel.templates.getSync(makeAgentClassID('gated'))!.systemPrompt, 'p', '违规 → 零注册表变更（整单原子拒绝）')
  })

  test('缺省目标 = 调用者所属类；user 根类走 config.user 不开放', async () => {
    const { kernel, tools } = await createKernelHarness(new FakeGateway(() => textEvents('ok')), {
      userClass: { tools: userTools },
    })
    await kernel.registerSystemTools(tools)
    const result = await updateViaTool(tools, { systemPrompt: 'hack myself' })
    assert.match(result.text, /user 根类/)
    assert.ok(kernel.templates.getSync(makeAgentClassID('user'))!.systemPrompt !== 'hack myself')
    void kernel
  })

  test('panel 机制类不可修改（红线：系统机制与用户基因分界）', async () => {
    const { kernel, tools } = await createKernelHarness(new FakeGateway(() => textEvents('ok')), {
      userClass: { tools: userTools },
    })
    await kernel.registerSystemTools(tools)
    await kernel.templates.register({
      name: makeAgentClassID('__strategy_role__'),
      description: 'panel',
      systemPrompt: 'role',
      tools: {},
      panel: true,
    })
    const result = await updateViaTool(tools, { name: '__strategy_role__', systemPrompt: 'x' })
    assert.match(result.text, /panel 类.*不可修改/)
  })

  test('目标类不存在 / 空 patch：明确报错不落盘', async () => {
    const { kernel, tools } = await createKernelHarness(new FakeGateway(() => textEvents('ok')), {
      userClass: { tools: userTools },
    })
    await kernel.registerSystemTools(tools)
    assert.match((await updateViaTool(tools, { name: 'ghost', systemPrompt: 'x' })).text, /类不存在/)
    assert.match((await updateViaTool(tools, { name: 'reviewer2', description: 'x' })).text, /类不存在/)
    await createViaTool(tools, { name: 'reviewer2', description: 'd', systemPrompt: 'p' })
    assert.match((await updateViaTool(tools, { name: 'reviewer2' })).text, /无可更新字段/)
  })

  test('边界（设计内）：更新只影响后续实例——已绑定实例能力物化不追改', async () => {
    const { kernel, tools } = await createKernelHarness(new FakeGateway(() => textEvents('ok')), {
      userClass: { tools: userTools },
    })
    await kernel.registerSystemTools(tools)
    await createViaTool(tools, { name: 'runner', description: 'd', systemPrompt: 'p', tools: { bash: 'allow' } })
    const first = await kernel.instantiateAgent(
      { className: makeAgentClassID('runner'), parentId: makeAgentID(USER_ID), userPrompt: 'go', agentId: makeAgentID('r1') },
      '/proj',
    )
    assert.equal(kernel.lineage.effectiveAccess(first, 'bash'), 'allow')
    // 类降档 bash deny → 只影响未来实例。
    await updateViaTool(tools, { name: 'runner', tools: { bash: 'deny' } })
    assert.equal(kernel.lineage.effectiveAccess(first, 'bash'), 'allow', '现役实例保持出生时物化（防"改类即远程改现役"）')
    const second = await kernel.instantiateAgent(
      { className: makeAgentClassID('runner'), parentId: makeAgentID(USER_ID), userPrompt: 'go' },
      '/proj',
    )
    assert.equal(kernel.lineage.effectiveAccess(second, 'bash'), 'deny', '新实例携带新基因出生')
  })
})
