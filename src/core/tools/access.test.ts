// ============================================================
// core/tools/access.ts 纯代数测试：四态严格度总序（restrictAccess）。
// 物化语义（白名单/继承/grant 封顶）见 lineage/AccessLedger.test。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { restrictAccess } from './access'
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
