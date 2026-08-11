// ============================================================
// core/tools/ToolCapabilityRegistry.test.ts —— 工具注册/权限/校验/钩子
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DefaultToolCapabilityRegistry } from './ToolCapabilityRegistry'
import type { ToolCapability, ToolContext, ToolError, PermissionResolver, ToolParametersSchema } from './types'
import { validateArgs } from './validate'

const adminCtx: ToolContext = { agentId: 'a1', spaceId: 's1', agentPermission: 'admin' }
const normalCtx: ToolContext = { agentId: 'a1', spaceId: 's1', agentPermission: 'normal' }

const echoTool: ToolCapability = {
  id: 'oc_echo',
  description: 'echo 文本',
  permission: 'normal',
  category: 'business',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: '要回显的文本' } },
    required: ['text'],
  },
  execute: (input) => ({ text: `Echo: ${(input as { text: string }).text}` }),
}

const adminTool: ToolCapability = {
  id: 'telemetry_read',
  description: '读取全量日志',
  permission: 'admin',
  category: 'telemetry',
  parameters: { type: 'object', properties: {} },
  execute: () => ({ text: 'logs…' }),
}

describe('validateArgs（JSON Schema 子集）', () => {
  const schema: ToolParametersSchema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      count: { type: 'number' },
      tags: { type: 'array', items: { type: 'string' } },
      level: { type: 'string', enum: ['low', 'high'] },
    },
    required: ['name'],
  }

  test('合法参数通过', () => {
    assert.equal(validateArgs({ name: 'x', count: 2, tags: ['a'], level: 'low' }, schema), undefined)
  })
  test('缺必填 → 报错', () => {
    assert.ok(validateArgs({ count: 1 }, schema)?.includes('name'))
  })
  test('类型不匹配 → 报错', () => {
    assert.ok(validateArgs({ name: 'x', count: 'two' }, schema)?.includes('count'))
    assert.ok(validateArgs({ name: 'x', tags: ['a', 1] }, schema)?.includes('tags'))
  })
  test('枚举不匹配 → 报错', () => {
    assert.ok(validateArgs({ name: 'x', level: 'mid' }, schema)?.includes('level'))
  })
  test('非对象 → 报错', () => {
    assert.ok(validateArgs('oops', schema))
  })
})

describe('DefaultToolCapabilityRegistry', () => {
  test('register / get / list / unregister + 重复注册冲突', async () => {
    const registry = new DefaultToolCapabilityRegistry()
    await registry.register(echoTool)
    assert.equal((await registry.get('oc_echo')).id, 'oc_echo')

    await assert.rejects(() => registry.register(echoTool), (e: unknown) => (e as ToolError).kind === 'tool_already_registered')

    const business = await registry.list({ category: 'business' })
    assert.equal(business.length, 1)
    assert.equal(business[0]?.id, 'oc_echo')

    await registry.unregister('oc_echo')
    await assert.rejects(() => registry.get('oc_echo'), (e: unknown) => (e as ToolError).kind === 'tool_not_found')
  })

  test('注册形状校验：缺 execute → 拒绝', async () => {
    const registry = new DefaultToolCapabilityRegistry()
    await assert.rejects(
      () => registry.register({ ...echoTool, execute: undefined } as never),
      (e: unknown) => (e as ToolError).kind === 'execution_failed',
    )
  })

  test('materialize：按权限过滤，转 LLM ToolDefinition', async () => {
    const registry = new DefaultToolCapabilityRegistry()
    await registry.register(echoTool)
    await registry.register(adminTool)

    const normal = registry.materialize('normal')
    assert.deepEqual(normal.map((t) => t.name), ['oc_echo'])

    const admin = registry.materialize('admin')
    assert.deepEqual(admin.map((t) => t.name).sort(), ['oc_echo', 'telemetry_read'])
    assert.equal(admin[0]?.parameters.type, 'object')
  })

  test('execute：成功执行并返回结果', async () => {
    const registry = new DefaultToolCapabilityRegistry()
    await registry.register(echoTool)
    const result = await registry.execute({ id: 'c1', name: 'oc_echo', input: { text: 'hi' } }, normalCtx)
    assert.equal(result.text, 'Echo: hi')
  })

  test('execute：权限不足 → permission_denied', async () => {
    const registry = new DefaultToolCapabilityRegistry()
    await registry.register(adminTool)
    await assert.rejects(
      () => registry.execute({ id: 'c1', name: 'telemetry_read', input: {} }, normalCtx),
      (e: unknown) => {
        const err = e as ToolError
        return err.kind === 'permission_denied' && err.required === 'admin' && err.actual === 'normal'
      },
    )
  })

  test('execute：参数不合法 → invalid_arguments', async () => {
    const registry = new DefaultToolCapabilityRegistry()
    await registry.register(echoTool)
    await assert.rejects(
      () => registry.execute({ id: 'c1', name: 'oc_echo', input: {} }, normalCtx),
      (e: unknown) => (e as ToolError).kind === 'invalid_arguments',
    )
  })

  test('execute：工具不存在 → tool_not_found', async () => {
    const registry = new DefaultToolCapabilityRegistry()
    await assert.rejects(
      () => registry.execute({ id: 'c1', name: 'ghost', input: {} }, normalCtx),
      (e: unknown) => (e as ToolError).kind === 'tool_not_found',
    )
  })

  test('执行器抛错 → execution_failed + onError 钩子触发', async () => {
    const calls: string[] = []
    const registry = new DefaultToolCapabilityRegistry({
      hooks: {
        onBeforeExecute: () => {
          calls.push('before')
        },
        onAfterExecute: () => {
          calls.push('after')
        },
        onError: () => {
          calls.push('error')
        },
      },
    })
    await registry.register({ ...echoTool, execute: () => Promise.reject(new Error('boom')) })

    await assert.rejects(
      () => registry.execute({ id: 'c1', name: 'oc_echo', input: { text: 'x' } }, normalCtx),
      (e: unknown) => (e as ToolError).kind === 'execution_failed',
    )
    assert.deepEqual(calls, ['before', 'error'])
  })

  test('成功后钩子顺序：before → execute → after', async () => {
    const order: string[] = []
    const registry = new DefaultToolCapabilityRegistry({
      hooks: {
        onBeforeExecute: () => {
          order.push('before')
        },
        onAfterExecute: () => {
          order.push('after')
        },
      },
    })
    await registry.register({ ...echoTool, execute: () => {
      order.push('execute')
      return { text: 'ok' }
    } })
    await registry.execute({ id: 'c1', name: 'oc_echo', input: { text: 'x' } }, normalCtx)
    assert.deepEqual(order, ['before', 'execute', 'after'])
  })

  test('可插拔权限策略：deny 名单', async () => {
    const denyEcho: PermissionResolver = {
      canExecute: (tool, _ctx) => tool.id !== 'oc_echo',
    }
    const registry = new DefaultToolCapabilityRegistry({ permissionResolver: denyEcho })
    await registry.register(echoTool)
    assert.equal(registry.materialize('admin').length, 0)
    await assert.rejects(
      () => registry.execute({ id: 'c1', name: 'oc_echo', input: { text: 'x' } }, adminCtx),
      (e: unknown) => (e as ToolError).kind === 'permission_denied',
    )
  })

  test('自定义 validate 优先于 schema 校验', async () => {
    const registry = new DefaultToolCapabilityRegistry()
    await registry.register({
      ...echoTool,
      validate: (input) => ((input as { text: string }).text === 'secret' ? '拒绝敏感词' : undefined),
    })
    await assert.rejects(
      () => registry.execute({ id: 'c1', name: 'oc_echo', input: { text: 'secret' } }, normalCtx),
      (e: unknown) => {
        const err = e as ToolError
        return err.kind === 'invalid_arguments' && err.message === '拒绝敏感词'
      },
    )
  })
})
