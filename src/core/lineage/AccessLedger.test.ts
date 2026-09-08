// ============================================================
// core/lineage/AccessLedger.test.ts —— 权限台账语义矩阵（活文档）
//
// 语义三则的完整回归：
//   ① 白名单本地性（fallback deny 不下传）；
//   ② 祖先只供显式判定（缺席≠否决；显式 deny/ask 取严；同级自身优先）；
//   ③ 加法 grant（清单形整表替换 + 未列一律 deny + 逐键祖先显式封顶）。
//   附：rebind 拓扑重放 / unbind 销毁。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DefaultAccessLedger } from './AccessLedger'
import type { ToolAccess } from '../tools'

const table = (entries: Record<string, ToolAccess>) => entries

describe('AccessLedger（族谱权限收敛台账）', () => {
  test('减法·白名单本地性：自身清单未列键 → deny（父显式 allow 也压不过子的封闭白名单）', () => {
    const ledger = new DefaultAccessLedger()
    ledger.bind({ agentId: '0', parentId: null, own: table({ read: 'allow', write: 'allow' }) })
    ledger.bind({ agentId: 'a1', parentId: '0', own: table({ read: 'allow' }) })

    assert.equal(ledger.effectiveAccess('a1', 'read'), 'allow')
    // write：父显式 allow，但子自身清单未列 → 本地封闭 deny（键即白名单）。
    assert.equal(ledger.effectiveAccess('a1', 'write'), 'deny')
    // user#0 未列 bash：自身清单已定义 → fallback deny。
    assert.equal(ledger.effectiveAccess('0', 'bash'), 'deny')
  })

  test('减法·祖先匿名兜底不下传：父 {read} 不锁死子新申请 {write:allow}', () => {
    const ledger = new DefaultAccessLedger()
    ledger.bind({ agentId: '0', parentId: null, own: table({ read: 'allow' }) })
    ledger.bind({ agentId: 'a1', parentId: '0', own: table({ write: 'allow' }) })
    // 父的 read-only 白名单对父自己生效（bash 等 = deny），
    // 但缺席 ≠ 否决——子的显式 write:allow 成立。
    assert.equal(ledger.effectiveAccess('a1', 'write'), 'allow')
    assert.equal(ledger.effectiveAccess('0', 'write'), 'deny')
  })

  test('减法·祖先显式判定取严（总序）：deny/ask 锁死子孙；藏匿与放宽均被压回', () => {
    const ledger = new DefaultAccessLedger()
    ledger.bind({
      agentId: '0',
      parentId: null,
      own: table({ bash: 'deny', edit: 'ask', hidden: 'ignore', shown: 'allow' }),
    })
    ledger.bind({
      agentId: 'a1',
      parentId: '0',
      own: table({ bash: 'allow', edit: 'allow', hidden: 'allow', shown: 'ignore' }),
    })
    assert.equal(ledger.effectiveAccess('a1', 'bash'), 'deny', '显式 deny 铁律：子的 allow 被压回 deny')
    assert.equal(ledger.effectiveAccess('a1', 'edit'), 'ask', 'ask ≺ allow：继承更严判定')
    assert.equal(ledger.effectiveAccess('a1', 'hidden'), 'allow', '祖先 ignore、子曝光为 allow = 收敛方向，成立')
    assert.equal(ledger.effectiveAccess('a1', 'shown'), 'allow', '总序裁决：子藏匿祖先 allow（→ignore）判扩张，压回 allow')
  })

  test('减法·不设限（undefined）= 完整继承父档案（显式判定 + 本地封闭）', () => {
    const ledger = new DefaultAccessLedger()
    ledger.bind({ agentId: '0', parentId: null, own: table({ read: 'allow' }) })
    ledger.bind({ agentId: 'a1', parentId: '0' /* own undefined */ })

    assert.equal(ledger.effectiveAccess('a1', 'read'), 'allow', '父显式 allow 完整继承')
    assert.equal(ledger.effectiveAccess('a1', 'write'), 'deny', '父的封闭随之继承——子面不宽于父')
    assert.equal(ledger.effectiveAccess('a1', 'bash'), 'deny')
    // 深链：孙照搬子的档案。
    ledger.bind({ agentId: 'a2', parentId: 'a1' })
    assert.equal(ledger.effectiveAccess('a2', 'read'), 'allow')
    assert.equal(ledger.effectiveAccess('a2', 'write'), 'deny')
  })

  test('减法·链上任一层显式 deny 逐级摊平（deny 不可被后序撤销）', () => {
    const ledger = new DefaultAccessLedger()
    ledger.bind({ agentId: '0', parentId: null })
    ledger.bind({ agentId: 'mid', parentId: '0', own: table({ bash: 'deny' }) })
    ledger.bind({ agentId: 'leaf', parentId: 'mid', own: table({ bash: 'allow' }) })
    assert.equal(ledger.effectiveAccess('leaf', 'bash'), 'deny')
  })

  test('加法·grant 清单形：整表替换（不受祖先匿名封闭追及），未列出键一律 deny', () => {
    const ledger = new DefaultAccessLedger()
    ledger.bind({ agentId: '0', parentId: null, own: table({ read: 'ask' }) })
    ledger.bind({ agentId: 'host', parentId: '0', own: table({}) })
    // 系统机制（策略模块）为 worker 加法给定：免逐个填 deny，其余自动 deny。
    ledger.bind({ agentId: 'worker', parentId: 'host', own: table({ read: 'allow', bash: 'allow' }), mode: 'grant' })

    assert.equal(ledger.effectiveAccess('worker', 'read'), 'allow', 'user#0 的 ask 被 host 空表匿名本地化（不下传）→ grant 不封顶')
    assert.equal(ledger.effectiveAccess('worker', 'bash'), 'allow', '祖先未列（host 封闭）不构成否决')
    assert.equal(ledger.effectiveAccess('worker', 'edit'), 'deny', '未指定 = 一律 deny（清单形即完整白名单）')
    assert.deepEqual(ledger.profileOf('worker')?.fallback, 'deny')
  })

  test('受限 grant：直接父摊平显式判定逐键封顶（ask 洗不成 allow；deny 铁律=最严特例）', () => {
    const ledger = new DefaultAccessLedger()
    ledger.bind({ agentId: '0', parentId: null, own: table({ edit: 'ask', bash: 'deny', hidden: 'ignore' }) })
    ledger.bind({ agentId: 'host', parentId: '0' /* 不设限：显式链原样摊平传递 */ })
    ledger.bind({
      agentId: 'w',
      parentId: 'host',
      own: table({ edit: 'allow', bash: 'allow', hidden: 'allow', novel: 'allow' }),
      mode: 'grant',
    })
    assert.equal(ledger.effectiveAccess('w', 'edit'), 'ask', '链上显式 ask 封顶 grant allow——加法通道洗不掉人审闸')
    assert.equal(ledger.effectiveAccess('w', 'bash'), 'deny', 'deny 铁律 = 封顶的最严特例')
    assert.equal(ledger.effectiveAccess('w', 'hidden'), 'allow', '祖先 ignore、grant allow = 曝光收敛，放行')
    assert.equal(ledger.effectiveAccess('w', 'novel'), 'allow', '链上无显式判定的新键不受封顶（键即白名单自限语义保留）')
  })

  test('加法·grant 鉴权：祖先链显式 deny 是不可豁免的铁律', () => {
    const ledger = new DefaultAccessLedger()
    ledger.bind({ agentId: '0', parentId: null, own: table({ bash: 'deny' }) })
    ledger.bind({ agentId: 'host', parentId: '0' })
    ledger.bind({ agentId: 'worker', parentId: 'host', own: table({ bash: 'allow', read: 'allow' }), mode: 'grant' })

    assert.equal(ledger.effectiveAccess('worker', 'bash'), 'deny', 'grant 无法豁免链上显式 deny')
    assert.equal(ledger.effectiveAccess('worker', 'read'), 'allow', '无 deny 铁律的键正常加法生效')
  })

  test('grant 子树仍走收敛：加法特权不传染（子的子按 inherit 收缩）', () => {
    const ledger = new DefaultAccessLedger()
    ledger.bind({ agentId: 'root', parentId: null })
    ledger.bind({ agentId: 'sys', parentId: 'root', own: table({ context_read: 'allow', context_edit: 'allow' }), mode: 'grant' })
    ledger.bind({ agentId: 'sub', parentId: 'sys', own: table({ context_read: 'allow' }) })

    assert.equal(ledger.effectiveAccess('sub', 'context_read'), 'allow', '继承摊平 + 自身显式')
    assert.equal(ledger.effectiveAccess('sub', 'context_edit'), 'deny', 'sub 自身白名单未列 → 本地封闭（不再享有 grant 特权）')
  })

  test('rebind：乱序重放按拓扑收敛（重启恢复路径）', () => {
    const ledger = new DefaultAccessLedger()
    ledger.rebind([
      { agentId: 'c', parentId: 'b', own: table({ read: 'allow' }) },
      { agentId: 'b', parentId: 'a', own: table({ read: 'allow', edit: 'ask' }) },
      { agentId: 'a', parentId: null, own: table({ edit: 'deny' }) },
    ])
    assert.equal(ledger.effectiveAccess('c', 'read'), 'allow')
    assert.equal(ledger.effectiveAccess('c', 'edit'), 'deny', '祖父显式 deny 摊平到孙')
    assert.equal(ledger.effectiveAccess('c', 'grep'), 'deny', 'c 自身清单已定义 → 未列键本地 deny')
  })

  test('unbind + 未绑定 agent：查询 undefined（调用方落默认）', () => {
    const ledger = new DefaultAccessLedger()
    ledger.bind({ agentId: 'a', parentId: null, own: table({ read: 'allow' }) })
    assert.equal(ledger.effectiveAccess('ghost', 'read'), undefined)
    ledger.unbind('a')
    assert.equal(ledger.has('a'), false)
    assert.equal(ledger.effectiveAccess('a', 'read'), undefined)
  })
})
