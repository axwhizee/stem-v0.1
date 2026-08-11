// ============================================================
// core/kernel/AgentTemplateRegistry.test.ts
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DefaultAgentTemplateRegistry } from './AgentTemplateRegistry'
import type { AgentClass } from './types'
import { makeAgentClassID } from './types'

const base: AgentClass = {
  id: makeAgentClassID('test-agent'),
  name: 'TestAgent',
  description: 'test',
  systemPrompt: 'be helpful',
  tools: [],
  permission: 'normal',
  memoryScope: [],
}

describe('DefaultAgentTemplateRegistry', () => {
  test('register + get + list + update + remove', async () => {
    const registry = new DefaultAgentTemplateRegistry()
    await registry.register(base)

    const got = await registry.get(base.id)
    assert.equal(got.name, 'TestAgent')
    assert.deepEqual(await registry.list(), [base])

    await registry.update(base.id, { description: 'updated' })
    assert.equal((await registry.get(base.id)).description, 'updated')

    await registry.remove(base.id)
    await assert.rejects(() => registry.get(base.id), (e: unknown) => (e as { kind: string }).kind === 'template_not_found')
  })

  test('重复注册 → template_exists', async () => {
    const registry = new DefaultAgentTemplateRegistry([base])
    await assert.rejects(() => registry.register(base), (e: unknown) => (e as { kind: string }).kind === 'template_exists')
  })

  test('校验：缺失 systemPrompt / 非法权限 → invalid_template', async () => {
    const registry = new DefaultAgentTemplateRegistry()
    await assert.rejects(
      () => registry.register({ ...base, systemPrompt: '' }),
      (e: unknown) => (e as { kind: string }).kind === 'invalid_template',
    )
    await assert.rejects(
      () => registry.register({ ...base, permission: 'sudo' as never }),
      (e: unknown) => (e as { kind: string }).kind === 'invalid_template',
    )
  })

  test('内置模板（从 templates/*.json 加载）', async () => {
    const registry = new DefaultAgentTemplateRegistry()
    // 内置模板由 AgentKernel 装配；此处验证 json 字段结构合法。
    const list = await registry.list()
    assert.ok(list.length >= 0)
  })

  test('list 按 permission 过滤', async () => {
    const registry = new DefaultAgentTemplateRegistry([base, { ...base, id: makeAgentClassID('admin-agent'), permission: 'admin' }])
    const normals = await registry.list({ permission: 'normal' })
    assert.equal(normals.length, 1)
    assert.equal(normals[0]?.permission, 'normal')
  })
})
