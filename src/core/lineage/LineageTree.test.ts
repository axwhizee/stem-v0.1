// ============================================================
// core/lineage/LineageTree.test.ts —— 族谱树单测（纯关系，不依赖 tools）
//
// 关系：InstanceManager（事实源）持有 parentId；
// LineageTree 是无状态查询视图（getChildren/ancestors/descendants/isAncestorOf/getRoot）。
// 权限继承（collectAncestorAccessLayers）为 tools/access 纯函数，此处一并验证。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DefaultTemplateRegistry, DefaultInstanceManager } from '../kernel'
import { DefaultLineageTree } from './LineageTree'
import type { AgentClass, AgentID } from '../kernel'
import { makeAgentClassID, makeAgentID } from '../kernel'

const cls: AgentClass = {
  name: makeAgentClassID('worker'),
  description: 'worker agent',
  systemPrompt: 'work',
  tools: { read: 'allow', write: 'deny' },
}

/** 构造 manager + lineage，并注册 user0 根（普通实例，parentId=null）。 */
async function makeTree() {
  const registry = new DefaultTemplateRegistry([cls])
  const manager = new DefaultInstanceManager(registry)
  const spaceId = 'space-1' as never
  await manager.instantiate({ className: cls.name, parentId: null, userPrompt: '', spaceId, agentId: 'user0' })
  const lineage = new DefaultLineageTree({
    getInstance: (id) => manager.getSync(id),
    getAllInstances: () => manager.listAllSync(),
  })
  return { manager, lineage, spaceId, registry }
}

describe('LineageTree（无状态查询视图，纯关系）', () => {
  test('祖先链：user0 根无祖先；子 agent 链到根', async () => {
    const { manager, lineage, spaceId } = await makeTree()
    const root = await manager.instantiate({ className: cls.name, parentId: makeAgentID('user0'), userPrompt: 'hi', spaceId, agentId: 'root1' })
    const child = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId, agentId: 'child1' })
    const grand = await manager.instantiate({ className: cls.name, parentId: child.id, userPrompt: 'hi', spaceId, agentId: 'grand1' })

    assert.deepEqual(lineage.getAncestors(makeAgentID('user0')), [])
    assert.deepEqual(lineage.getAncestors(root.id), ['user0'])
    assert.deepEqual(lineage.getAncestors(child.id), [root.id, 'user0'])
    assert.deepEqual(lineage.getAncestors(grand.id), [child.id, root.id, 'user0'])
  })

  test('children / descendants：BFS 子树', async () => {
    const { manager, lineage, spaceId } = await makeTree()
    const root = await manager.instantiate({ className: cls.name, parentId: makeAgentID('user0'), userPrompt: 'hi', spaceId, agentId: 'root2' })
    const c1 = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId, agentId: 'c1' })
    const c2 = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId, agentId: 'c2' })
    await manager.instantiate({ className: cls.name, parentId: c1.id, userPrompt: 'hi', spaceId, agentId: 'c1a' })

    assert.deepEqual([...lineage.getChildren(root.id)].sort(), ['c1', 'c2'])
    assert.deepEqual([...lineage.getDescendants(root.id)].sort(), ['c1', 'c1a', 'c2'])
    assert.deepEqual(lineage.getDescendants(c2.id), [])
    // 兄弟不属于彼此后代。
    assert.ok(!lineage.getDescendants(c1.id).includes(c2.id))
  })

  test('isAncestorOf：销毁权判定（user0 根恒 true）', async () => {
    const { manager, lineage, spaceId } = await makeTree()
    const root = await manager.instantiate({ className: cls.name, parentId: makeAgentID('user0'), userPrompt: 'hi', spaceId, agentId: 'root3' })
    const child = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId, agentId: 'child3' })

    assert.equal(lineage.isAncestorOf(makeAgentID('user0'), child.id), true)
    assert.equal(lineage.isAncestorOf(root.id, child.id), true)
    assert.equal(lineage.isAncestorOf(child.id, root.id), false)
    assert.equal(lineage.isAncestorOf(child.id, child.id), false)
  })

  test('getRoot：祖先链末端为根；自身即根时返回自身', async () => {
    const { manager, lineage, spaceId } = await makeTree()
    const root = await manager.instantiate({ className: cls.name, parentId: makeAgentID('user0'), userPrompt: 'hi', spaceId, agentId: 'root4' })
    const child = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId, agentId: 'child4' })

    assert.equal(lineage.getRoot(makeAgentID('user0')), 'user0')
    assert.equal(lineage.getRoot(root.id), 'user0')
    assert.equal(lineage.getRoot(child.id), 'user0')
  })

  test('销毁权：非祖先调用者被拒；有活跃子默认拒绝；recursive 级联', async () => {
    const { manager, spaceId } = await makeTree()
    const root = await manager.instantiate({ className: cls.name, parentId: makeAgentID('user0'), userPrompt: 'hi', spaceId, agentId: 'root6' })
    const child = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId, agentId: 'child6' })

    // 非祖先（另一个游离 agent）销毁 → denied。
    const outsider = await manager.instantiate({ className: cls.name, parentId: makeAgentID('user0'), userPrompt: 'hi', spaceId, agentId: 'out6' })
    await assert.rejects(
      () => manager.terminate(child.id, { by: outsider.id }),
      (e: unknown) => (e as { kind: string }).kind === 'agent_terminate_denied',
    )

    // 根销毁子 → 允许。
    await manager.terminate(child.id, { by: makeAgentID('user0') })

    // 有活跃子默认拒绝。
    const child2 = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId, agentId: 'child6b' })
    await assert.rejects(
      () => manager.terminate(root.id, { by: makeAgentID('user0') }),
      (e: unknown) => (e as { kind: string }).kind === 'agent_has_children',
    )

    // recursive 级联销毁整棵子树。
    const grand = await manager.instantiate({ className: cls.name, parentId: child2.id, userPrompt: 'hi', spaceId, agentId: 'grand6' })
    await manager.terminate(root.id, { by: makeAgentID('user0'), recursive: true })
    for (const id of [root.id, child2.id, grand.id] as AgentID[]) {
      await assert.rejects(() => manager.get(id), (e: unknown) => (e as { kind: string }).kind === 'agent_not_found')
    }
  })

  test('元 agent（user0）不可销毁', async () => {
    const { manager } = await makeTree()
    await assert.rejects(
      () => manager.terminate(makeAgentID('user0'), { by: makeAgentID('user0') }),
      (e: unknown) => (e as { kind: string }).kind === 'agent_terminate_denied',
    )
  })

  test('父不存在 → agent_conflict', async () => {
    const { manager, spaceId } = await makeTree()
    await assert.rejects(
      () => manager.instantiate({ className: cls.name, parentId: makeAgentID('ghost'), userPrompt: 'hi', spaceId }),
      (e: unknown) => (e as { kind: string }).kind === 'agent_conflict',
    )
  })
})

// ---------- S5.1：能力相（台账并入）+ 可见域（统一树谓词） ----------

describe('LineageTree 门面（能力物化：attach/effectiveAccess/replay/detach）', () => {
  test('attach 两步曲：根整表 → 子清单收敛（继承→取严）', async () => {
    const { lineage } = await makeTree()
    lineage.attach({ agentId: 'user0', parentId: null, own: { read: 'allow', bash: 'ask' } })
    lineage.attach({ agentId: 'a', parentId: 'user0', own: { read: 'deny' } }) // 子封闭：只列 read
    // 根的显式 ask 锁子孙、子未列键本地封闭（fallback deny 兜底）。
    assert.equal(lineage.effectiveAccess('a', 'read'), 'deny')
    assert.equal(lineage.effectiveAccess('a', 'bash'), 'deny', '子清单封闭：未列键兜底 deny')
    assert.equal(lineage.effectiveAccess('a', 'zzz'), 'deny')
    // 自身档案可见（fallback = 本地封闭 deny）。
    const profile = lineage.profileOf('a')
    assert.equal(profile?.fallback, 'deny')
    assert.deepEqual(profile?.explicit, { read: 'deny' })
    // 根：ask 原样物化。
    assert.equal(lineage.effectiveAccess('user0', 'bash'), 'ask')
  })

  test('祖先显式 deny 铁律：子显式 allow 也压不回（restrictAccess 取严）', async () => {
    const { lineage } = await makeTree()
    lineage.attach({ agentId: 'user0', parentId: null, own: { edit: 'deny' } })
    lineage.attach({ agentId: 'a', parentId: 'user0', own: { edit: 'allow' } })
    assert.equal(lineage.effectiveAccess('a', 'edit'), 'deny')
  })

  test('grant 整表替换：未列一律 deny，祖先显式 deny 仍不可豁免', async () => {
    const { lineage } = await makeTree()
    lineage.attach({ agentId: 'user0', parentId: null, own: { read: 'allow', run: 'deny' } })
    lineage.attach({ agentId: 'w', parentId: 'user0', own: { read: 'allow', run: 'allow' }, mode: 'grant' })
    assert.equal(lineage.effectiveAccess('w', 'read'), 'allow')
    assert.equal(lineage.effectiveAccess('w', 'run'), 'deny', 'grant 豁免不了显式 deny 铁律')
    assert.equal(lineage.effectiveAccess('w', 'other'), 'deny', 'grant 后未列一律 deny（整表替换封闭）')
    assert.equal(lineage.profileOf('w')?.fallback, 'deny')
  })

  test('replay 乱序集合 → 拓扑序物化（重启重放等价于逐次 attach）', async () => {
    const { lineage } = await makeTree()
    lineage.replay([
      { agentId: 'g', parentId: 'p', own: { read: 'allow' } }, // 孙（先给出）
      { agentId: 'user0', parentId: null, own: { read: 'ask', bash: 'allow' } },
      { agentId: 'p', parentId: 'user0', own: { read: 'allow', bash: 'ask' } },
    ])
    // 父 ask 锁孙：乱序输入下 g.read 仍收敛为 ask。
    assert.equal(lineage.effectiveAccess('g', 'read'), 'ask')
    assert.equal(lineage.effectiveAccess('p', 'bash'), 'ask')
    assert.ok(lineage.has('g') && lineage.has('user0') && !lineage.has('nobody'))
  })

  test('detach 摘除档案（销毁级联：查询回落未绑定）', async () => {
    const { lineage } = await makeTree()
    lineage.attach({ agentId: 'user0', parentId: null, own: { read: 'allow' } })
    assert.ok(lineage.has('user0'))
    lineage.detach('user0')
    assert.ok(!lineage.has('user0'))
    assert.equal(lineage.effectiveAccess('user0', 'read'), undefined)
    assert.equal(lineage.profileOf('user0'), undefined)
  })
})

describe('LineageTree.canReach（可见域：自身 ∪ 祖先代查）', () => {
  test('矩阵：自身 true；祖先 true；后代 false；兄弟 false；根全视', async () => {
    const { manager, lineage, spaceId } = await makeTree()
    const root = await manager.instantiate({ className: cls.name, parentId: makeAgentID('user0'), userPrompt: 'hi', spaceId, agentId: 'R' })
    const a = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId, agentId: 'A' })
    const a1 = await manager.instantiate({ className: cls.name, parentId: a.id, userPrompt: 'hi', spaceId, agentId: 'A1' })
    const b = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId, agentId: 'B' })

    // 自身
    assert.ok(lineage.canReach(a.id, a.id))
    // 祖先 → 后代（含隔代）
    assert.ok(lineage.canReach(root.id, a1.id))
    assert.ok(lineage.canReach(makeAgentID('user0'), b.id))
    // 后代 → 祖先：不可见（可见域单向向下）
    assert.ok(!lineage.canReach(a1.id, root.id))
    assert.ok(!lineage.canReach(a.id, makeAgentID('user0')))
    // 兄弟互不可见
    assert.ok(!lineage.canReach(a.id, b.id))
    // 根天然全视
    for (const id of [root.id, a.id, a1.id, b.id]) assert.ok(lineage.canReach(makeAgentID('user0'), id))
  })
})
// ---------- S6 模型配置相（docs/s6-plan.md R6/R14） ----------

const M = (id: string) => ({ provider: 'test', id })

describe('LineageTree 模型配置相（显式 > 类基因 > 父继承 > 家学）', () => {
  test('四级律逐级命中与优先级', async () => {
    const { lineage } = await makeTree()
    // 家学（根的类层 = config.user.model 语义位）
    lineage.attach({ agentId: 'user0', parentId: null, model: { classModel: M('home-m') } })
    assert.deepEqual(lineage.modelOf('user0'), { ref: M('home-m'), origin: 'home' })
    // 父继承：无自身模型 → 家学值下传保持 origin=home（blame 指到锚点）
    lineage.attach({ agentId: 'plain', parentId: 'user0' })
    assert.deepEqual(lineage.modelOf('plain'), { ref: M('home-m'), origin: 'home' })
    // 类基因：非根类模型 → class 层
    lineage.attach({ agentId: 'w', parentId: 'user0', model: { classModel: M('class-m') } })
    assert.deepEqual(lineage.modelOf('w'), { ref: M('class-m'), origin: 'class' })
    // 显式（实例行）> 类基因
    lineage.attach({ agentId: 'x', parentId: 'user0', model: { instanceModel: M('exp-m'), classModel: M('class-m') } })
    assert.deepEqual(lineage.modelOf('x'), { ref: M('exp-m'), origin: 'explicit' })
    // 类下传 → inherited（父的 class 层对子只是继承）
    lineage.attach({ agentId: 'wc', parentId: 'w' })
    assert.deepEqual(lineage.modelOf('wc'), { ref: M('class-m'), origin: 'inherited' })
    // 隔代继承链：孙随父走
    lineage.attach({ agentId: 'p2', parentId: 'plain' })
    assert.deepEqual(lineage.modelOf('p2'), { ref: M('home-m'), origin: 'home' })
  })

  test('全链无锚 → undefined（不伪造兜底模型；boot 硬校验的运行时形态）', async () => {
    const { lineage } = await makeTree()
    lineage.attach({ agentId: 'user0', parentId: null })
    assert.equal(lineage.modelOf('user0'), undefined)
    lineage.attach({ agentId: 'a', parentId: 'user0' })
    assert.equal(lineage.modelOf('a'), undefined)
  })

  test('改父不动子的物化形态 = 出生快照层（重构裁决：setModel 直改口退役，行写+replay 统一）', async () => {
    const { lineage } = await makeTree()
    const SNAPSHOT = { ref: M('home-m'), origin: 'home' as const }
    // 出生：p 无显式落 home；oldChild 随 kernel attach 规则写快照
    lineage.attach({ agentId: 'user0', parentId: null, model: { classModel: M('home-m') } })
    lineage.attach({ agentId: 'p', parentId: 'user0' })
    lineage.attach({ agentId: 'oldChild', parentId: 'p', model: { snapshot: SNAPSHOT } })
    assert.deepEqual(lineage.modelOf('oldChild'), SNAPSHOT)
    // 运行期 p 换模型 = 实例行写显式层 → 全树 replay 重解析
    lineage.replay([
      { agentId: 'user0', parentId: null, model: { classModel: M('home-m') } },
      { agentId: 'p', parentId: 'user0', model: { instanceModel: M('new-m') } },
      { agentId: 'oldChild', parentId: 'p', model: { snapshot: SNAPSHOT } },
    ])
    assert.deepEqual(lineage.modelOf('p'), { ref: M('new-m'), origin: 'explicit' })
    assert.deepEqual(lineage.modelOf('oldChild'), SNAPSHOT, '既有子女受快照保护，不受改父影响')
    lineage.attach({ agentId: 'newChild', parentId: 'p' })
    assert.deepEqual(lineage.modelOf('newChild'), { ref: M('new-m'), origin: 'inherited' }, '新子女随改后档案')
  })

  test('replay 乱序集合：模型相与权限相同拓拓扑序重建（显式层随实例行恢复）', async () => {
    const { lineage } = await makeTree()
    lineage.replay([
      { agentId: 'g', parentId: 'p' }, // 孙先给
      { agentId: 'p', parentId: 'user0', model: { classModel: M('p-class') } },
      { agentId: 'user0', parentId: null, model: { classModel: M('home-m') } },
    ])
    assert.deepEqual(lineage.modelOf('g'), { ref: M('p-class'), origin: 'inherited' })
    assert.deepEqual(lineage.modelOf('user0'), { ref: M('home-m'), origin: 'home' })
  })

  test('replay（模拟重启）：显式层由实例行传入，运行期改档延续', async () => {
    // 新树重放（updateAgent 已把显式层写进行——replay 天然承接，无特判）
    const fresh = new DefaultLineageTree({
      getInstance: (id) => undefined,
      getAllInstances: () => [],
    })
    fresh.replay([
      { agentId: 'user0', parentId: null, model: { classModel: M('home-m') } },
      { agentId: 'a', parentId: 'user0', model: { instanceModel: M('set-m') } },
    ])
    assert.deepEqual(fresh.modelOf('a'), { ref: M('set-m'), origin: 'explicit' })
  })

  test('detach 摘除模型档案；nodeConfigOf 出示整像（access + model）', async () => {
    const { lineage } = await makeTree()
    lineage.attach({ agentId: 'user0', parentId: null, own: { read: 'allow' }, model: { classModel: M('home-m') } })
    const node = lineage.nodeConfigOf('user0')
    assert.deepEqual(node?.model, { ref: M('home-m'), origin: 'home' })
    assert.equal(node?.access.explicit['read'], 'allow')
    assert.equal(lineage.nodeConfigOf('nobody'), undefined)
    lineage.detach('user0')
    assert.equal(lineage.modelOf('user0'), undefined)
    assert.equal(lineage.nodeConfigOf('user0'), undefined)
  })
})

describe('LineageTree 出生快照层（S6 §5 族规跨重启）', () => {
  test('replay：子女快照优先于父行现值（改父后重启族规不失效）；显式层遮蔽快照', async () => {
    const { lineage } = await makeTree()
    // 父亲行已带改后值 swapped；子女行只存出生快照 old-p。
    lineage.replay([
      { agentId: 'user0', parentId: null, model: { classModel: M('home-m') } },
      { agentId: 'p', parentId: 'user0', model: { instanceModel: M('swapped') } },
      { agentId: 'c', parentId: 'p', model: { snapshot: { ref: M('old-p'), origin: 'inherited' } } },
    ])
    assert.deepEqual(lineage.modelOf('p'), { ref: M('swapped'), origin: 'explicit' })
    assert.deepEqual(lineage.modelOf('c'), { ref: M('old-p'), origin: 'inherited' }, '快照 = 出生时族谱真相')
    // 子女自身显式遮蔽快照。
    lineage.attach({
      agentId: 'c',
      parentId: 'p',
      model: { instanceModel: M('own'), snapshot: { ref: M('old-p'), origin: 'inherited' } },
    })
    assert.deepEqual(lineage.modelOf('c'), { ref: M('own'), origin: 'explicit' })
  })
})
