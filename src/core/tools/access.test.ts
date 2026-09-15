// ============================================================
// core/tools/access.ts 纯代数测试：四态严格度总序 + 收敛链折叠。
// 物化语义（白名单/继承/grant 封顶）见 lineage/AccessLedger.test。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { checkToolsConvergence, foldConvergenceSteps, restrictAccess } from './access'
import type { ToolAccess } from './types'

const ALL: readonly ToolAccess[] = ['deny', 'ask', 'allow', 'ignore']

describe('restrictAccess（总序单链：deny ≺ ask ≺ allow ≺ ignore，取更严）', () => {
  test('deny 严格支配一切', () => {
    for (const other of ALL) {
      if (other === 'deny') continue
      assert.equal(restrictAccess('deny', other), 'deny', `deny ⊓ ${other}`)
      assert.equal(restrictAccess(other, 'deny'), 'deny', `${other} ⊓ deny`)
    }
  })

  test('ask 严格于 allow 与 ignore（人审闸盖不过）', () => {
    assert.equal(restrictAccess('ask', 'allow'), 'ask')
    assert.equal(restrictAccess('allow', 'ask'), 'ask')
    assert.equal(restrictAccess('ask', 'ignore'), 'ask')
    assert.equal(restrictAccess('ignore', 'ask'), 'ask')
  })

  test('allow 严格于 ignore（藏匿=扩张被拒；曝光=收敛放行）', () => {
    // 祖先 allow、自身想改 ignore → 压回 allow（不能藏起祖先给的能力）
    assert.equal(restrictAccess('ignore', 'allow'), 'allow')
    // 祖先 ignore、自身 allow → 曝光更多监督，取 allow
    assert.equal(restrictAccess('allow', 'ignore'), 'allow')
  })

  test('同值幂等', () => {
    for (const a of ALL) assert.equal(restrictAccess(a, a), a)
  })

  test('单调性抽查：任何组合结果不宽于两输入', () => {
    const RANK: Record<ToolAccess, number> = { deny: 0, ask: 1, allow: 2, ignore: 3 }
    for (const a of ALL) {
      for (const b of ALL) {
        const r = restrictAccess(a, b)
        assert.ok(RANK[r]! <= RANK[a]! && RANK[r]! <= RANK[b]!, `${a}⊓${b}=${r}`)
      }
    }
  })
})

describe('foldConvergenceSteps（白名单步 / raise 步 / 封顶与违例）', () => {
  test('replace 步 = 键即白名单：未列键出局并本地封闭 deny', () => {
    const { profile, violations } = foldConvergenceSteps(
      { a: 'allow', b: 'ask' },
      { a: 'allow', b: 'allow', c: 'ignore' },
      [['类收敛', { a: 'allow' }]],
    )
    assert.deepEqual(violations, [])
    assert.deepEqual(profile.explicit, { a: 'allow' })
    assert.equal(profile.fallback, 'deny')
  })

  test('整表缺席（无步）= 完整继承父显式；无白名单步则无本地封闭', () => {
    const { profile, violations } = foldConvergenceSteps({ a: 'ask' }, { a: 'allow' }, [])
    assert.deepEqual(violations, [])
    assert.deepEqual(profile.explicit, { a: 'ask' })
    assert.equal(profile.fallback, undefined)
  })

  test('封顶：步内取值宽于 出生∧父显式 → 违例；物化侧钳制为封顶值', () => {
    const { profile, violations } = foldConvergenceSteps(
      {},
      { bash: 'ask' }, // 出生封顶 ask
      [['类收敛', { bash: 'ignore' }]],
    )
    assert.equal(violations.length, 1)
    assert.deepEqual(
      { layer: violations[0]!.layer, key: violations[0]!.key, wanted: violations[0]!.wanted, ceiling: violations[0]!.ceiling },
      { layer: '类收敛', key: 'bash', wanted: 'ignore', ceiling: 'ask' },
    )
    assert.deepEqual(profile.explicit, { bash: 'ask' }, '静默压回封顶')
  })

  test('父显式判定参与封顶：父 deny 锁死后续步', () => {
    const { profile, violations } = foldConvergenceSteps(
      { bash: 'deny' },
      { bash: 'ignore' },
      [['实例收敛', { bash: 'allow' }]],
    )
    assert.equal(violations.length, 1)
    assert.equal(violations[0]!.ceiling, 'deny')
    assert.deepEqual(profile.explicit, { bash: 'deny' })
  })

  test('raise 步只抬不封：表外键穿过，不产生本地封闭', () => {
    const { profile, violations } = foldConvergenceSteps(
      { a: 'allow', b: 'deny' },
      { a: 'ignore', b: 'ignore', c: 'ignore' },
      [
        ['类收敛', { a: 'allow', b: 'deny' }],
        ['策略收敛', { a: 'ask' }, 'raise'],
      ],
    )
    assert.deepEqual(violations, [])
    assert.deepEqual(profile.explicit, { a: 'ask', b: 'deny' })
    assert.equal(profile.fallback, 'deny', '白名单步仍在 → 本地封闭保留')
  })

  test('多步独立归因：类步与实例步违例分开报', () => {
    const { violations } = foldConvergenceSteps(
      {},
      { x: 'ask', y: 'allow' },
      [
        ['类收敛', { x: 'allow' }],
        ['实例收敛', { y: 'ignore' }],
      ],
    )
    assert.deepEqual(
      violations.map((v) => `${v.layer}:${v.key}`),
      ['类收敛:x', '实例收敛:y'],
    )
  })
})
