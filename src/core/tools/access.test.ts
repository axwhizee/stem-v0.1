// ============================================================
// core/tools/access.ts 纯代数测试：四态偏序（restrictAccess）。
// 分层收敛/白名单物化语义已迁往 lineage/AccessLedger.test。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { restrictAccess } from './access'

describe('restrictAccess（单调收缩偏序）', () => {
  test('deny 严格支配一切', () => {
    assert.equal(restrictAccess('deny', 'allow'), 'deny')
    assert.equal(restrictAccess('allow', 'deny'), 'deny')
    assert.equal(restrictAccess('deny', 'ignore'), 'deny')
    assert.equal(restrictAccess('ask', 'deny'), 'deny')
  })

  test('ask 严格于 allow/ignore', () => {
    assert.equal(restrictAccess('ask', 'allow'), 'ask')
    assert.equal(restrictAccess('allow', 'ask'), 'ask')
    assert.equal(restrictAccess('ask', 'ignore'), 'ask')
  })

  test('allow/ignore 同级：取严结果保留第一个参数（同级归属由调用方决定）', () => {
    // 台账用法：restrictAccess(自身值, 祖先值) → 同级时自身值优先（可见性自决）。
    assert.equal(restrictAccess('allow', 'ignore'), 'allow')
    assert.equal(restrictAccess('ignore', 'allow'), 'ignore')
  })
})
