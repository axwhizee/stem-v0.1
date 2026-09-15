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
import { makeAgentClassID, makeAgentID, ROOT_ID } from '../kernel'

const cls: AgentClass = {
  name: makeAgentClassID('worker'),
  description: 'worker agent',
  systemPrompt: 'work',
  tools: { read: 'allow', write: 'deny' },
}

/** 构造 manager + lineage，并注册根（id 纯推导 `0`，parentId=null）。 */
async function makeTree() {
  const registry = new DefaultTemplateRegistry([cls])
  const manager = new DefaultInstanceManager(registry)
  
  await manager.instantiate({ className: cls.name, parentId: null, userPrompt: '' })
  const lineage = new DefaultLineageTree({
    getInstance: (id) => manager.getSync(id),
    getAllInstances: () => manager.listAllSync(),
  })
  return { manager, lineage, registry }
}

describe('LineageTree（无状态查询视图，纯关系）', () => {
  test('祖先链：根无祖先；子 agent 链到根', async () => {
    const { manager, lineage } = await makeTree()
    const root = await manager.instantiate({ className: cls.name, parentId: ROOT_ID, userPrompt: 'hi' })
    const child = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi' })
    const grand = await manager.instantiate({ className: cls.name, parentId: child.id, userPrompt: 'hi' })

    assert.equal(root.id, '1')
    assert.deepEqual(lineage.getAncestors(ROOT_ID), [])
    assert.deepEqual(lineage.getAncestors(root.id), [ROOT_ID])
    assert.deepEqual(lineage.getAncestors(child.id), [root.id, ROOT_ID])
    assert.deepEqual(lineage.getAncestors(grand.id), [child.id, root.id, ROOT_ID])
  })

  test('children / descendants：BFS 子树', async () => {
    const { manager, lineage } = await makeTree()
    const root = await manager.instantiate({ className: cls.name, parentId: ROOT_ID, userPrompt: 'hi' })
    const c1 = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi' })
    const c2 = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi' })
    const c1a = await manager.instantiate({ className: cls.name, parentId: c1.id, userPrompt: 'hi' })

    assert.deepEqual([...lineage.getChildren(root.id)].sort(), [c1.id, c2.id])
    assert.deepEqual([...lineage.getDescendants(root.id)].sort(), [c1.id, c1a.id, c2.id])
    assert.deepEqual(lineage.getDescendants(c2.id), [])
    // 兄弟不属于彼此后代。
    assert.ok(!lineage.getDescendants(c1.id).includes(c2.id))
  })

  test('isAncestorOf：销毁权判定（根恒 true）', async () => {
    const { manager, lineage } = await makeTree()
    const root = await manager.instantiate({ className: cls.name, parentId: ROOT_ID, userPrompt: 'hi' })
    const child = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi' })

    assert.equal(lineage.isAncestorOf(ROOT_ID, child.id), true)
    assert.equal(lineage.isAncestorOf(root.id, child.id), true)
    assert.equal(lineage.isAncestorOf(child.id, root.id), false)
    assert.equal(lineage.isAncestorOf(child.id, child.id), false)
  })

  test('getRoot：祖先链末端为根；自身即根时返回自身', async () => {
    const { manager, lineage } = await makeTree()
    const root = await manager.instantiate({ className: cls.name, parentId: ROOT_ID, userPrompt: 'hi' })
    const child = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi' })

    assert.equal(lineage.getRoot(ROOT_ID), ROOT_ID)
    assert.equal(lineage.getRoot(root.id), ROOT_ID)
    assert.equal(lineage.getRoot(child.id), ROOT_ID)
  })

  test('销毁权：非祖先调用者被拒；有活跃子默认拒绝；recursive 级联', async () => {
    const { manager } = await makeTree()
    const root = await manager.instantiate({ className: cls.name, parentId: ROOT_ID, userPrompt: 'hi' })
    const child = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi' })

    // 非祖先（另一个兄弟实例）销毁 → denied。
    const outsider = await manager.instantiate({ className: cls.name, parentId: ROOT_ID, userPrompt: 'hi' })
    await assert.rejects(
      () => manager.terminate(child.id, { by: outsider.id }),
      (e: unknown) => (e as { kind: string }).kind === 'agent_terminate_denied',
    )

    // 根销毁子 → 允许。
    await manager.terminate(child.id, { by: ROOT_ID })

    // 有活跃子默认拒绝。
    const child2 = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi' })
    await assert.rejects(
      () => manager.terminate(root.id, { by: ROOT_ID }),
      (e: unknown) => (e as { kind: string }).kind === 'agent_has_children',
    )

    // recursive 级联销毁整棵子树。
    const grand = await manager.instantiate({ className: cls.name, parentId: child2.id, userPrompt: 'hi' })
    await manager.terminate(root.id, { by: ROOT_ID, recursive: true })
    for (const id of [root.id, child2.id, grand.id] as AgentID[]) {
      await assert.rejects(() => manager.get(id), (e: unknown) => (e as { kind: string }).kind === 'agent_not_found')
    }
  })

  test('根不可销毁（无祖先，结构性事实）', async () => {
    const { manager } = await makeTree()
    await assert.rejects(
      () => manager.terminate(ROOT_ID, { by: ROOT_ID }),
      (e: unknown) => (e as { kind: string }).kind === 'agent_terminate_denied',
    )
  })

  test('父不存在 → agent_conflict', async () => {
    const { manager } = await makeTree()
    await assert.rejects(
      () => manager.instantiate({ className: cls.name, parentId: makeAgentID('ghost'), userPrompt: 'hi' }),
      (e: unknown) => (e as { kind: string }).kind === 'agent_conflict',
    )
  })

  test('审计律 B1：前缀 ⇔ isAncestorOf（含空洞/销毁随机对拍，活体面）', async () => {
    const { manager, lineage } = await makeTree()
    // 随机生长 30 实例（每步在活体中随机挑父）+ 中途 recursive 销毁制造空洞。
    const live: AgentID[] = [ROOT_ID]
    const ever: AgentID[] = [ROOT_ID]
    let seed = 42
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    for (let i = 0; i < 30; i++) {
      const parent = live[Math.floor(rnd() * live.length)]!
      const child = await manager.instantiate({ className: cls.name, parentId: parent, userPrompt: 'hi' })
      live.push(child.id)
      ever.push(child.id)
      if (rnd() > 0.8) {
        // 级联销毁随机一员（recursive 保活体面无断链——这本身由本测试对拍）。
        const victim = live[1 + Math.floor(rnd() * (live.length - 1))]
        if (victim !== undefined) {
          await manager.terminate(victim, { by: ROOT_ID, recursive: true })
          for (const id of [...live]) if (!manager.getSync(id)) live.splice(live.indexOf(id), 1)
        }
      }
    }
    assert.ok(live.length > 5, '样本存活充足')
    for (const a of live) {
      for (const b of live) {
        if (a === b) continue
        // 路径前缀 ⇔ 结构祖先（活体面互验；权限裁决权威仍是物化，编码不是旁路）。
        // id = x.x：根是全树祖先；其余 = `<id>.` 前缀。
        const prefix =
          a === ROOT_ID ? b !== ROOT_ID : b.startsWith(`${a}.`)
        assert.equal(
          lineage.isAncestorOf(a, b),
          prefix,
          `prefix(=${String(prefix)}) ⇔ isAncestorOf(=${String(lineage.isAncestorOf(a, b))}) ${a}→${b}`,
        )
      }
    }
    // 活体链无洞：每个活体的祖先链（父→根）全活且 = id 逐段前缀反序。
    for (const b of live) {
      const prefixes: string[] = []
      let cur = b as string
      while (cur !== ROOT_ID) {
        const cut = cur.lastIndexOf('.')
        if (cut < 0) {
          prefixes.push(ROOT_ID)
          cur = ROOT_ID
        } else {
          cur = cur.slice(0, cut)
          prefixes.push(cur)
        }
      }
      assert.deepEqual(lineage.getAncestors(b).slice(), prefixes, `chain ${b}`)
    }
  })
})

// ---------- S5.1：能力相（台账并入）+ 可见域（统一树谓词） ----------

describe('LineageTree 门面（能力物化：attach/effectiveAccess/replay/detach）', () => {
  test('attach 两步曲：根整表 → 子清单收敛（继承→取严）', async () => {
    const { lineage } = await makeTree()
    lineage.attach({ agentId: '0', parentId: null, own: { read: 'allow', bash: 'ask' } })
    lineage.attach({ agentId: 'a', parentId: '0', own: { read: 'deny' } }) // 子封闭：只列 read
    // 根的显式 ask 锁子孙、子未列键本地封闭（fallback deny 兜底）。
    assert.equal(lineage.effectiveAccess('a', 'read'), 'deny')
    assert.equal(lineage.effectiveAccess('a', 'bash'), 'deny', '子清单封闭：未列键兜底 deny')
    assert.equal(lineage.effectiveAccess('a', 'zzz'), 'deny')
    // 自身档案可见（fallback = 本地封闭 deny）。
    const profile = lineage.profileOf('a')
    assert.equal(profile?.fallback, 'deny')
    assert.deepEqual(profile?.explicit, { read: 'deny' })
    // 根：ask 原样物化。
    assert.equal(lineage.effectiveAccess('0', 'bash'), 'ask')
  })

  test('祖先显式 deny 铁律：子显式 allow 也压不回（restrictAccess 取严）', async () => {
    const { lineage } = await makeTree()
    lineage.attach({ agentId: '0', parentId: null, own: { edit: 'deny' } })
    lineage.attach({ agentId: 'a', parentId: '0', own: { edit: 'allow' } })
    assert.equal(lineage.effectiveAccess('a', 'edit'), 'deny')
  })

  test('grant 整表替换：未列一律 deny，祖先显式 deny 仍不可豁免', async () => {
    const { lineage } = await makeTree()
    lineage.attach({ agentId: '0', parentId: null, own: { read: 'allow', run: 'deny' } })
    lineage.attach({ agentId: 'w', parentId: '0', own: { read: 'allow', run: 'allow' }, mode: 'grant' })
    assert.equal(lineage.effectiveAccess('w', 'read'), 'allow')
    assert.equal(lineage.effectiveAccess('w', 'run'), 'deny', 'grant 豁免不了显式 deny 铁律')
    assert.equal(lineage.effectiveAccess('w', 'other'), 'deny', 'grant 后未列一律 deny（整表替换封闭）')
    assert.equal(lineage.profileOf('w')?.fallback, 'deny')
  })

  test('replay 乱序集合 → 拓扑序物化（重启重放等价于逐次 attach）', async () => {
    const { lineage } = await makeTree()
    lineage.replay([
      { agentId: 'g', parentId: 'p', own: { read: 'allow' } }, // 孙（先给出）
      { agentId: '0', parentId: null, own: { read: 'ask', bash: 'allow' } },
      { agentId: 'p', parentId: '0', own: { read: 'allow', bash: 'ask' } },
    ])
    // 父 ask 锁孙：乱序输入下 g.read 仍收敛为 ask。
    assert.equal(lineage.effectiveAccess('g', 'read'), 'ask')
    assert.equal(lineage.effectiveAccess('p', 'bash'), 'ask')
    assert.ok(lineage.has('g') && lineage.has('0') && !lineage.has('nobody'))
  })

  test('detach 摘除档案（销毁级联：查询回落未绑定）', async () => {
    const { lineage } = await makeTree()
    lineage.attach({ agentId: '0', parentId: null, own: { read: 'allow' } })
    assert.ok(lineage.has('0'))
    lineage.detach('0')
    assert.ok(!lineage.has('0'))
    assert.equal(lineage.effectiveAccess('0', 'read'), undefined)
    assert.equal(lineage.profileOf('0'), undefined)
  })
})

describe('LineageTree.canReach（可见域：自身 ∪ 祖先代查）', () => {
  test('矩阵：自身 true；祖先 true；后代 false；兄弟 false；根全视', async () => {
    const { manager, lineage } = await makeTree()
    const root = await manager.instantiate({ className: cls.name, parentId: ROOT_ID, userPrompt: 'hi' })
    const a = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi' })
    const a1 = await manager.instantiate({ className: cls.name, parentId: a.id, userPrompt: 'hi' })
    const b = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi' })

    // 自身
    assert.ok(lineage.canReach(a.id, a.id))
    // 祖先 → 后代（含隔代）
    assert.ok(lineage.canReach(root.id, a1.id))
    assert.ok(lineage.canReach(ROOT_ID, b.id))
    // 后代 → 祖先：不可见（可见域单向向下）
    assert.ok(!lineage.canReach(a1.id, root.id))
    assert.ok(!lineage.canReach(a.id, ROOT_ID))
    // 兄弟互不可见
    assert.ok(!lineage.canReach(a.id, b.id))
    // 根天然全视
    for (const id of [root.id, a.id, a1.id, b.id]) assert.ok(lineage.canReach(ROOT_ID, id))
  })
})
// ---------- S6 模型配置相（docs/s6-plan.md R6/R14） ----------

const M = (id: string) => ({ provider: 'test', id })

describe('LineageTree 模型配置相（显式 > 类基因 > 父继承）', () => {
  test('逐级命中与优先级（严格父子相对）', async () => {
    const { lineage } = await makeTree()
    // 根的类基因（config.user.model 语义位；与非根同一 class 层）
    lineage.attach({ agentId: '0', parentId: null, model: { classModel: M('home-m') } })
    assert.deepEqual(lineage.modelOf('0'), { ref: M('home-m'), origin: 'class' })
    // 父继承：无自身模型 → 继承父生效表
    lineage.attach({ agentId: 'plain', parentId: '0' })
    assert.deepEqual(lineage.modelOf('plain'), { ref: M('home-m'), origin: 'inherited' })
    // 类基因：非根类模型 → class 层
    lineage.attach({ agentId: 'w', parentId: '0', model: { classModel: M('class-m') } })
    assert.deepEqual(lineage.modelOf('w'), { ref: M('class-m'), origin: 'class' })
    // 显式（实例行）> 类基因
    lineage.attach({ agentId: 'x', parentId: '0', model: { instanceModel: M('exp-m'), classModel: M('class-m') } })
    assert.deepEqual(lineage.modelOf('x'), { ref: M('exp-m'), origin: 'explicit' })
    // 类下传 → inherited（父的 class 层对子只是继承）
    lineage.attach({ agentId: 'wc', parentId: 'w' })
    assert.deepEqual(lineage.modelOf('wc'), { ref: M('class-m'), origin: 'inherited' })
    // 隔代继承链：孙随父走
    lineage.attach({ agentId: 'p2', parentId: 'plain' })
    assert.deepEqual(lineage.modelOf('p2'), { ref: M('home-m'), origin: 'inherited' })
  })

  test('全链无锚 → undefined（不伪造兜底模型；boot 硬校验的运行时形态）', async () => {
    const { lineage } = await makeTree()
    lineage.attach({ agentId: '0', parentId: null })
    assert.equal(lineage.modelOf('0'), undefined)
    lineage.attach({ agentId: 'a', parentId: '0' })
    assert.equal(lineage.modelOf('a'), undefined)
  })

  test('改父不动子的物化形态 = 出生快照层（重构裁决：setModel 直改口退役，行写+replay 统一）', async () => {
    const { lineage } = await makeTree()
    const SNAPSHOT = { ref: M('home-m'), origin: 'inherited' as const }
    // 出生：p 无显式落父继承；oldChild 随 kernel attach 规则写快照
    lineage.attach({ agentId: '0', parentId: null, model: { classModel: M('home-m') } })
    lineage.attach({ agentId: 'p', parentId: '0' })
    lineage.attach({ agentId: 'oldChild', parentId: 'p', model: { resolved: SNAPSHOT } })
    assert.deepEqual(lineage.modelOf('oldChild'), SNAPSHOT)
    // 运行期 p 换模型 = 实例行写显式层 → 全树 replay 重解析
    lineage.replay([
      { agentId: '0', parentId: null, model: { classModel: M('home-m') } },
      { agentId: 'p', parentId: '0', model: { instanceModel: M('new-m') } },
      { agentId: 'oldChild', parentId: 'p', model: { resolved: SNAPSHOT } },
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
      { agentId: 'p', parentId: '0', model: { classModel: M('p-class') } },
      { agentId: '0', parentId: null, model: { classModel: M('home-m') } },
    ])
    assert.deepEqual(lineage.modelOf('g'), { ref: M('p-class'), origin: 'inherited' })
    assert.deepEqual(lineage.modelOf('0'), { ref: M('home-m'), origin: 'class' })
  })

  test('replay（模拟重启）：显式层由实例行传入，运行期改档延续', async () => {
    // 新树重放（updateAgent 已把显式层写进行——replay 天然承接，无特判）
    const fresh = new DefaultLineageTree({
      getInstance: (id) => undefined,
      getAllInstances: () => [],
    })
    fresh.replay([
      { agentId: '0', parentId: null, model: { classModel: M('home-m') } },
      { agentId: 'a', parentId: '0', model: { instanceModel: M('set-m') } },
    ])
    assert.deepEqual(fresh.modelOf('a'), { ref: M('set-m'), origin: 'explicit' })
  })

  test('detach 摘除模型档案；nodeConfigOf 出示整像（access + model）', async () => {
    const { lineage } = await makeTree()
    lineage.attach({ agentId: '0', parentId: null, own: { read: 'allow' }, model: { classModel: M('home-m') } })
    const node = lineage.nodeConfigOf('0')
    assert.deepEqual(node?.model, { ref: M('home-m'), origin: 'class' })
    assert.equal(node?.access.explicit['read'], 'allow')
    assert.equal(lineage.nodeConfigOf('nobody'), undefined)
    lineage.detach('0')
    assert.equal(lineage.modelOf('0'), undefined)
    assert.equal(lineage.nodeConfigOf('0'), undefined)
  })
})

describe('LineageTree 出生快照层（S6 §5 族规跨重启）', () => {
  test('replay：子女快照优先于父行现值（改父后重启族规不失效）；显式层遮蔽快照', async () => {
    const { lineage } = await makeTree()
    // 父亲行已带改后值 swapped；子女行只存出生快照 old-p。
    lineage.replay([
      { agentId: '0', parentId: null, model: { classModel: M('home-m') } },
      { agentId: 'p', parentId: '0', model: { instanceModel: M('swapped') } },
      { agentId: 'c', parentId: 'p', model: { resolved: { ref: M('old-p'), origin: 'inherited' } } },
    ])
    assert.deepEqual(lineage.modelOf('p'), { ref: M('swapped'), origin: 'explicit' })
    assert.deepEqual(lineage.modelOf('c'), { ref: M('old-p'), origin: 'inherited' }, '快照 = 出生时族谱真相')
    // 子女自身显式遮蔽快照。
    lineage.attach({
      agentId: 'c',
      parentId: 'p',
      model: { instanceModel: M('own'), resolved: { ref: M('old-p'), origin: 'inherited' } },
    })
    assert.deepEqual(lineage.modelOf('c'), { ref: M('own'), origin: 'explicit' })
  })
})
