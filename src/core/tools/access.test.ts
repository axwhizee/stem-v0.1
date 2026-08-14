// ============================================================
// core/tools/access.test.ts —— 工具访问评估单测（权限融合核心）
//
// 四态：allow / ask / deny / ignore。
// 偏序（单调收缩）：deny ≺ ask ≺ {allow, ignore}。
// 分层评估：层间取最严格；默认值仅兜底（不参与 restrict）。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateAccess, restrictAccess, toolAccessToRules } from './access'
import type { ToolAccess, ToolAccessRules } from './types'

const allow: ToolAccessRules = [{ key: 'read', action: 'allow' }]
const deny: ToolAccessRules = [{ key: 'read', action: 'deny' }]
const ask: ToolAccessRules = [{ key: 'read', action: 'ask' }]
const ignore: ToolAccessRules = [{ key: 'read', action: 'ignore' }]

describe('restrictAccess（单调收缩偏序）', () => {
  test('deny 最严格：deny 与任意组合保持 deny', () => {
    assert.equal(restrictAccess('deny', 'allow'), 'deny')
    assert.equal(restrictAccess('allow', 'deny'), 'deny')
    assert.equal(restrictAccess('deny', 'ignore'), 'deny')
    assert.equal(restrictAccess('ask', 'deny'), 'deny')
  })
  test('ask 居中：ask+allow → ask；ask+ignore → ask', () => {
    assert.equal(restrictAccess('ask', 'allow'), 'ask')
    assert.equal(restrictAccess('allow', 'ask'), 'ask')
    assert.equal(restrictAccess('ask', 'ignore'), 'ask')
  })
  test('allow 与 ignore 同级（同级返回前者）', () => {
    assert.equal(restrictAccess('allow', 'ignore'), 'allow')
    assert.equal(restrictAccess('ignore', 'allow'), 'ignore')
  })
})

describe('evaluateAccess（分层评估）', () => {
  test('默认值兜底：无命中 → 返回 defaultAccess', () => {
    assert.equal(evaluateAccess('read', [], 'ask'), 'ask')
    assert.equal(evaluateAccess('read', [], 'ignore'), 'ignore')
    assert.equal(evaluateAccess('read', [allow]), 'allow')
  })

  test('层间取最严格：全局 allow + 类 deny → deny', () => {
    // [全局(最弱), 类(局部)]：类 deny 覆盖全局 allow → deny
    assert.equal(evaluateAccess('read', [allow, deny], 'ask'), 'deny')
    assert.equal(evaluateAccess('read', [deny, allow], 'ask'), 'deny')
  })

  test('显式 allow 覆盖默认 ignore（internal 系统工具显式启用）', () => {
    // 默认 ignore 仅是兜底，不参与 restrict → 显式 allow 生效
    assert.equal(evaluateAccess('read', [allow], 'ignore'), 'allow')
  })

  test('层内最后命中优先', () => {
    const layer: ToolAccessRules = [
      { key: 'read', action: 'deny' },
      { key: 'read', action: 'allow' },
    ]
    assert.equal(evaluateAccess('read', [layer], 'ask'), 'allow')
  })

  test('多工具：不同访问键互不影响', () => {
    const rules: ToolAccessRules = [
      { key: 'read', action: 'allow' },
      { key: 'write', action: 'deny' },
    ]
    assert.equal(evaluateAccess('read', [rules], 'ask'), 'allow')
    assert.equal(evaluateAccess('write', [rules], 'ask'), 'deny')
    assert.equal(evaluateAccess('grep', [rules], 'ask'), 'ask')
  })
})

describe('toolAccessToRules', () => {
  test('Record<访问键, 动作> → 规则数组', () => {
    assert.deepEqual(toolAccessToRules({ read: 'allow', write: 'deny' }), [
      { key: 'read', action: 'allow' },
      { key: 'write', action: 'deny' },
    ])
    assert.deepEqual(toolAccessToRules(undefined), [])
  })
})

// 类型守卫：四态合法值
const _allActions: readonly ToolAccess[] = ['allow', 'ask', 'deny', 'ignore']
void _allActions
