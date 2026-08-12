// ============================================================
// core/tools/ToolCapabilityRegistry.test.ts —— 工具注册/权限/校验/钩子
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DefaultToolCapabilityRegistry } from './ToolCapabilityRegistry'
import type { ToolCapability, ToolContext, ToolError, ToolParametersSchema } from './types'
import type { PermissionManager, PermissionRequest, PermissionRules } from '../permission'
import { DefaultPermissionManager } from '../permission'
import { validateArgs } from './validate'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const emptyRules: PermissionRules = []
const allowEchoRules: PermissionRules = [{ tool: 'oc_echo', action: 'allow' }]
const denyEchoRules: PermissionRules = [{ tool: 'oc_echo', action: 'deny' }]

const baseCtx: ToolContext = { agentId: 'a1', spaceId: 's1', rules: allowEchoRules }

const echoTool: ToolCapability = {
  id: 'oc_echo',
  description: 'echo 文本',
  category: 'business',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: '要回显的文本' } },
    required: ['text'],
  },
  execute: (input) => ({ text: `Echo: ${(input as { text: string }).text}` }),
}

const telemetryTool: ToolCapability = {
  id: 'telemetry_read',
  description: '读取全量日志',
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

  test('materialize：deny 的工具不暴露，其余转 LLM ToolDefinition', async () => {
    const registry = new DefaultToolCapabilityRegistry()
    await registry.register(echoTool)
    await registry.register(telemetryTool)

    const allowBoth: PermissionRules = [
      { tool: 'oc_echo', action: 'allow' },
      { tool: 'telemetry_read', action: 'allow' },
    ]
    const all = registry.materialize(allowBoth)
    assert.deepEqual(all.map((t) => t.name).sort(), ['oc_echo', 'telemetry_read'])
    assert.equal(all[0]?.parameters.type, 'object')

    // deny telemetry_read → 只暴露 echo
    const denyTelemetry: PermissionRules = [{ tool: 'telemetry_read', action: 'deny' }]
    assert.deepEqual(registry.materialize(denyTelemetry).map((t) => t.name), ['oc_echo'])
  })

  test('execute：allow 规则直接执行', async () => {
    const registry = new DefaultToolCapabilityRegistry()
    await registry.register(echoTool)
    const result = await registry.execute({ id: 'c1', name: 'oc_echo', input: { text: 'hi' } }, baseCtx)
    assert.equal(result.text, 'Echo: hi')
  })

  test('execute：deny 规则 → permission_denied（不弹窗）', async () => {
    const permission: PermissionManager = new DefaultPermissionManager({ askPanel: () => {} })
    const registry = new DefaultToolCapabilityRegistry({ permission })
    await registry.register(echoTool)
    const ctx: ToolContext = { ...baseCtx, rules: denyEchoRules }
    await assert.rejects(
      () => registry.execute({ id: 'c1', name: 'oc_echo', input: { text: 'x' } }, ctx),
      (e: unknown) => {
        const err = e as ToolError
        return err.kind === 'permission_denied' && err.permission === 'oc_echo'
      },
    )
  })

  test('execute：ask（缺省/无规则）→ 挂起 → once 批准后执行', async () => {
    let request: PermissionRequest | undefined
    const permission: PermissionManager = new DefaultPermissionManager({ askPanel: (req) => void (request = req) })
    const registry = new DefaultToolCapabilityRegistry({ permission })
    await registry.register(echoTool)

    const ctx: ToolContext = { agentId: 'a1', spaceId: 's1', rules: emptyRules }
    const execution = registry.execute({ id: 'c1', name: 'oc_echo', input: { text: 'hi' } }, ctx)
    await tick()
    assert.ok(request, '无规则 → 默认 ask，应产生权限请求')

    await permission.reply({ requestId: request!.id, reply: 'once' })
    const result = await execution
    assert.equal(result.text, 'Echo: hi')
  })

  test('execute：ask → reject → permission_rejected', async () => {
    let request: PermissionRequest | undefined
    const permission: PermissionManager = new DefaultPermissionManager({ askPanel: (req) => void (request = req) })
    const registry = new DefaultToolCapabilityRegistry({ permission })
    await registry.register(echoTool)

    const execution = registry.execute({ id: 'c1', name: 'oc_echo', input: { text: 'hi' } }, { ...baseCtx, rules: emptyRules })
    await tick()
    await permission.reply({ requestId: request!.id, reply: 'reject', message: '不需要' })
    await assert.rejects(
      () => execution,
      (e: unknown) => {
        const err = e as ToolError
        return err.kind === 'permission_rejected' && err.feedback === '不需要'
      },
    )
  })

  test('execute：ask → always 后同类工具不再询问（session 批准）', async () => {
    const requests: PermissionRequest[] = []
    const permission: PermissionManager = new DefaultPermissionManager({ askPanel: (req) => void requests.push(req) })
    const registry = new DefaultToolCapabilityRegistry({ permission })
    await registry.register(echoTool)

    const ctx: ToolContext = { agentId: 'a1', spaceId: 's1', rules: emptyRules }
    const first = registry.execute({ id: 'c1', name: 'oc_echo', input: { text: 'hi' } }, ctx)
    await tick()
    await permission.reply({ requestId: requests[0]!.id, reply: 'always' })
    await first

    const second = await registry.execute({ id: 'c2', name: 'oc_echo', input: { text: 'again' } }, ctx)
    assert.equal(second.text, 'Echo: again')
    assert.equal(requests.length, 1, 'always 后同类工具不再弹窗')
  })

  test('execute：参数不合法 → invalid_arguments', async () => {
    const registry = new DefaultToolCapabilityRegistry()
    await registry.register(echoTool)
    await assert.rejects(
      () => registry.execute({ id: 'c1', name: 'oc_echo', input: {} }, baseCtx),
      (e: unknown) => (e as ToolError).kind === 'invalid_arguments',
    )
  })

  test('execute：工具不存在 → tool_not_found', async () => {
    const registry = new DefaultToolCapabilityRegistry()
    await assert.rejects(
      () => registry.execute({ id: 'c1', name: 'ghost', input: {} }, baseCtx),
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
      () => registry.execute({ id: 'c1', name: 'oc_echo', input: { text: 'x' } }, baseCtx),
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
    await registry.register({
      ...echoTool,
      execute: () => {
        order.push('execute')
        return { text: 'ok' }
      },
    })
    await registry.execute({ id: 'c1', name: 'oc_echo', input: { text: 'x' } }, baseCtx)
    assert.deepEqual(order, ['before', 'execute', 'after'])
  })

  test('自定义 validate 优先于 schema 校验', async () => {
    const registry = new DefaultToolCapabilityRegistry()
    await registry.register({
      ...echoTool,
      validate: (input) => ((input as { text: string }).text === 'secret' ? '拒绝敏感词' : undefined),
    })
    await assert.rejects(
      () => registry.execute({ id: 'c1', name: 'oc_echo', input: { text: 'secret' } }, baseCtx),
      (e: unknown) => {
        const err = e as ToolError
        return err.kind === 'invalid_arguments' && err.message === '拒绝敏感词'
      },
    )
  })
})
