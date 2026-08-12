// ============================================================
// core/permission/PermissionManager.test.ts —— 权限评估与管理器
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluate, permissionsToRules } from './evaluate'
import { DefaultPermissionManager } from './PermissionManager'
import type { PermissionRequest, PermissionRules } from './types'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('evaluate（统一 per-tool 权限评估）', () => {
  test('未命中规则 → 默认 ask', () => {
    assert.equal(evaluate('read', []), 'ask')
    assert.equal(evaluate('read', [{ tool: 'edit', action: 'allow' }]), 'ask')
  })

  test('命中规则 → 返回动作', () => {
    const rules: PermissionRules = [
      { tool: 'read', action: 'allow' },
      { tool: 'edit', action: 'deny' },
    ]
    assert.equal(evaluate('read', rules), 'allow')
    assert.equal(evaluate('edit', rules), 'deny')
  })

  test('最后命中的规则优先', () => {
    const rules: PermissionRules = [
      { tool: 'read', action: 'deny' },
      { tool: 'read', action: 'allow' },
    ]
    assert.equal(evaluate('read', rules), 'allow')
  })

  test('permissionsToRules：Record 转规则数组', () => {
    assert.deepEqual(permissionsToRules({ read: 'allow', bash: 'deny' }), [
      { tool: 'read', action: 'allow' },
      { tool: 'bash', action: 'deny' },
    ])
    assert.deepEqual(permissionsToRules(undefined), [])
  })
})

describe('DefaultPermissionManager', () => {
  const make = (requests: PermissionRequest[] = []) => {
    const manager = new DefaultPermissionManager({ askPanel: (req) => void requests.push(req) })
    return { manager, requests }
  }

  test('allow 规则直接通过，不弹窗', async () => {
    const { manager } = make()
    await manager.assert({ permission: 'read', agentId: 'a1', rules: [{ tool: 'read', action: 'allow' }] })
    assert.equal(manager.list().length, 0)
  })

  test('deny 规则 → permission_denied，不弹窗', async () => {
    const { manager, requests } = make()
    await assert.rejects(
      () => manager.assert({ permission: 'bash', agentId: 'a1', rules: [{ tool: 'bash', action: 'deny' }] }),
      (e: { kind?: string }) => e.kind === 'permission_denied',
    )
    assert.equal(requests.length, 0)
  })

  test('ask（缺省）→ 挂起 + 发面板请求 → once 通过', async () => {
    const { manager, requests } = make()
    const execution = manager.assert({ permission: 'edit', agentId: 'a1', rules: [] })
    await tick()
    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.permission, 'edit')
    assert.equal(requests[0]?.agentId, 'a1')

    await manager.reply({ requestId: requests[0]!.id, reply: 'once' })
    await execution // 不抛错即通过
    assert.equal(manager.list().length, 0)
  })

  test('ask → always 后同类权限免询问（session 批准优先于 agent deny）', async () => {
    const { manager, requests } = make()
    const first = manager.assert({ permission: 'edit', agentId: 'a1', rules: [] })
    await tick()
    await manager.reply({ requestId: requests[0]!.id, reply: 'always' })
    await first

    // 第二次：无规则（默认 ask），但 always 已写入 approved → 直接通过
    await manager.assert({ permission: 'edit', agentId: 'a1', rules: [] })
    assert.equal(requests.length, 1, 'always 后不再弹窗')

    // 即使 agent 规则 deny，用户已批准仍通过（用户批准优先）
    await manager.assert({ permission: 'edit', agentId: 'a1', rules: [{ tool: 'edit', action: 'deny' }] })
    assert.equal(requests.length, 1)
  })

  test('ask → reject → permission_rejected（可带反馈）', async () => {
    const { manager, requests } = make()
    const execution = manager.assert({ permission: 'edit', agentId: 'a1', rules: [] })
    await tick()
    await manager.reply({ requestId: requests[0]!.id, reply: 'reject', message: '不需要编辑' })
    await assert.rejects(
      () => execution,
      (e: { kind?: string; feedback?: string }) => e.kind === 'permission_rejected' && e.feedback === '不需要编辑',
    )
  })

  test('reply 不存在的请求 → permission_not_found', async () => {
    const { manager } = make()
    await assert.rejects(
      () => manager.reply({ requestId: 'perm_nope', reply: 'once' }),
      (e: { kind?: string }) => e.kind === 'permission_not_found',
    )
  })
})
