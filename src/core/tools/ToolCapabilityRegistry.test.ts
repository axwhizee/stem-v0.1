// ============================================================
// core/tools/ToolCapabilityRegistry.test.ts —— 工具注册/权限/校验/钩子
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DefaultToolCapabilityRegistry } from './ToolCapabilityRegistry'
import type { ToolCapability, ToolContext, ToolError, ToolParametersSchema, ToolAccess, AccessResolver, AccessRequest } from './types'
import type { AccessAskBus } from './accessRequest'
import { DefaultAccessAskBus } from './accessRequest'
import { validateArgs } from './validate'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** 固定判定表 resolver（模拟族谱台账；缺席 = undefined → 落注册声明 birth）。 */
const tableResolver = (table: Record<string, ToolAccess | undefined>): AccessResolver => ({
  accessOf: (_agentId, key) => table[key],
})

const baseCtx: ToolContext = { agentId: 'a1' }

const echoTool: ToolCapability = {
  id: 'oc_echo',
  registerAccess: 'ask', // 业务工具自报 registerAccess：无人显式判定时挂起询问
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
  registerAccess: 'ignore',
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

  test('materialize：deny/ignore 的工具不暴露，其余转 LLM ToolDefinition', async () => {
    const registry = new DefaultToolCapabilityRegistry({
      resolver: tableResolver({ oc_echo: 'allow', telemetry_read: 'allow' }),
    })
    await registry.register(echoTool)
    await registry.register(telemetryTool)

    const all = registry.materialize('a1')
    assert.deepEqual(all.map((t) => t.name).sort(), ['oc_echo', 'telemetry_read'])
    assert.equal(all[0]?.parameters.type, 'object')

    // deny telemetry_read → 只暴露 echo（echo 无判定 → 默认 ask 仍暴露）。
    const denyRegistry = new DefaultToolCapabilityRegistry({ resolver: tableResolver({ telemetry_read: 'deny' }) })
    await denyRegistry.register(echoTool)
    await denyRegistry.register(telemetryTool)
    assert.deepEqual(denyRegistry.materialize('a1').map((t) => t.name), ['oc_echo'])
  })

  test('kind 不参与权限推断（注册声明决定；审计定律 1 的单元侧锚）', async () => {
    // registerAccess ignore：无论 kind 为何值都隐藏（背景在场不设防）。
    for (const kind of ['internal', 'extension', 'custom'] as const) {
      const hidden = new DefaultToolCapabilityRegistry()
      await hidden.register({ ...echoTool, registerAccess: 'ignore', kind })
      assert.deepEqual(hidden.materialize('a1').map((t) => t.name), [], `registerAccess=ignore kind=${kind} 应隐藏`)
    }
    // registerAccess allow：无论 kind 为何值都直接暴露（族谱无判定）。
    for (const kind of ['internal', 'extension', 'custom'] as const) {
      const shown = new DefaultToolCapabilityRegistry()
      await shown.register({ ...echoTool, registerAccess: 'allow', kind })
      assert.deepEqual(shown.materialize('a1').map((t) => t.name), ['oc_echo'], `registerAccess=allow kind=${kind} 应暴露`)
    }
    // 族谱显式判定仍可收紧：registerAccess allow + 链上 ask → 暴露（ask 上清单）。
    const askReg = new DefaultToolCapabilityRegistry({ resolver: tableResolver({ oc_echo: 'ask' }) })
    await askReg.register({ ...echoTool, registerAccess: 'allow', kind: 'internal' })
    assert.deepEqual(askReg.materialize('a1').map((t) => t.name), ['oc_echo'])
  })

  test('execute：allow 规则直接执行', async () => {
    const registry = new DefaultToolCapabilityRegistry()
    await registry.register(echoTool)
    const result = await registry.execute({ id: 'c1', name: 'oc_echo', input: { text: 'hi' } }, baseCtx)
    assert.equal(result.text, 'Echo: hi')
  })

  test('execute：deny 判定 → access_denied（不弹窗）', async () => {
    const access: AccessAskBus = new DefaultAccessAskBus({
      askRoot: () => {},
      getRoot: () => '0',
      resolve: tableResolver({ oc_echo: 'deny' }),
    })
    const registry = new DefaultToolCapabilityRegistry({ access })
    await registry.register(echoTool)
    await assert.rejects(
      () => registry.execute({ id: 'c1', name: 'oc_echo', input: { text: 'x' } }, baseCtx),
      (e: unknown) => {
        const err = e as ToolError
        return err.kind === 'access_denied' && err.accessKey === 'oc_echo'
      },
    )
  })

  test('execute：ask（无判定 → 默认）→ 挂起 → once 批准后执行', async () => {
    let request: AccessRequest | undefined
    const access: AccessAskBus = new DefaultAccessAskBus({ askRoot: (req) => void (request = req), getRoot: () => '0' })
    const registry = new DefaultToolCapabilityRegistry({ access })
    await registry.register(echoTool)

    const execution = registry.execute({ id: 'c1', name: 'oc_echo', input: { text: 'hi' } }, baseCtx)
    await tick()
    assert.ok(request, '无判定 → 默认 ask，应产生访问确认请求')

    await access.reply({ requestId: request!.id, reply: 'once' }, '0')
    const result = await execution
    assert.equal(result.text, 'Echo: hi')
  })

  test('execute：ask → reject → access_rejected', async () => {
    let request: AccessRequest | undefined
    const access: AccessAskBus = new DefaultAccessAskBus({ askRoot: (req) => void (request = req), getRoot: () => '0' })
    const registry = new DefaultToolCapabilityRegistry({ access })
    await registry.register(echoTool)

    const execution = registry.execute({ id: 'c1', name: 'oc_echo', input: { text: 'hi' } }, baseCtx)
    await tick()
    await access.reply({ requestId: request!.id, reply: 'reject', message: '不需要' }, '0')
    await assert.rejects(
      () => execution,
      (e: unknown) => {
        const err = e as ToolError
        return err.kind === 'access_rejected' && err.feedback === '不需要'
      },
    )
  })

  test('execute：ask → always 后同类工具不再询问（session 批准）', async () => {
    const requests: AccessRequest[] = []
    const access: AccessAskBus = new DefaultAccessAskBus({ askRoot: (req) => void requests.push(req), getRoot: () => '0' })
    const registry = new DefaultToolCapabilityRegistry({ access })
    await registry.register(echoTool)

    const ctx: ToolContext = { agentId: 'a1' }
    const first = registry.execute({ id: 'c1', name: 'oc_echo', input: { text: 'hi' } }, ctx)
    await tick()
    await access.reply({ requestId: requests[0]!.id, reply: 'always' }, '0')
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

  test('执行器抛错 → execution_failed', async () => {
    const registry = new DefaultToolCapabilityRegistry()
    await registry.register({ ...echoTool, execute: () => Promise.reject(new Error('boom')) })

    await assert.rejects(
      () => registry.execute({ id: 'c1', name: 'oc_echo', input: { text: 'x' } }, baseCtx),
      (e: unknown) => (e as ToolError).kind === 'execution_failed',
    )
  })

  test('自定义 validate 优先于 schema 校验', async () => {
    const registry = new DefaultToolCapabilityRegistry()
    await registry.register({
      ...echoTool,
      validate: (input) => ((input as { text?: string }).text === undefined ? 'text 必填' : undefined),
    })
    await assert.rejects(
      () => registry.execute({ id: 'c1', name: 'oc_echo', input: {} }, baseCtx),
      (e: unknown) => (e as ToolError).kind === 'invalid_arguments',
    )
  })
})
