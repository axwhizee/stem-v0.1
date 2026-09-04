// ============================================================
// core/kernel/Runtime.test.ts —— 运行时单元测试（被动驱动）
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeGateway, GatewayError, abortError } from '../gateway'
import type { ModelRef } from '../gateway'
import { DefaultRepository, DefaultCourier, DefaultContextManager } from '../context'
import type { AgentDelivery } from '../context'
import { DefaultToolCapabilityRegistry } from '../tools'
import { DefaultTemplateRegistry } from './TemplateRegistry'
import { DefaultInstanceManager } from './InstanceManager'
import { DefaultRuntime } from './Runtime'
import type { AgentClass } from './types'
import { makeAgentClassID, makeAgentID, makeAgentSpaceID } from './types'

const cls: AgentClass = {
  name: makeAgentClassID('chat'),
  description: 'chat agent',
  systemPrompt: 'You are assistant.',
  tools: {},
}

const model = { provider: 'opencode', id: 'test-model' }

function deliveryFor(agentId: string, system = cls.systemPrompt): AgentDelivery {
  return { kind: 'agent', agentId, system, messages: [{ role: 'user', content: 'hi' }], messageIds: ['m-1'] }
}

async function makeRuntime(
  gateway: FakeGateway,
  extra?: {
    tools?: DefaultToolCapabilityRegistry
    template?: AgentClass
    resolveModel?: () => ModelRef | undefined
    maxSteps?: number
  },
) {
  const logs: import('../logging').LogEvent[] = []
  const templates = new DefaultTemplateRegistry(extra?.template !== undefined ? [cls, extra.template] : [cls])
  const instances = new DefaultInstanceManager(templates)
  // 根 agent（user0）：普通实例（parentId=null），作为最终回复投递目标。
  await instances.instantiate({
    className: (extra?.template ?? cls).name,
    parentId: null,
    userPrompt: '',
    spaceId: makeAgentSpaceID('__meta__'),
    agentId: 'user0',
  })
  const repository = new DefaultRepository()
  const courier = new DefaultCourier({ repository, defaultCountdownMs: 0 })
  const contextManager = new DefaultContextManager({ repository, courier })
  repository.onChange = (agentId) => contextManager.handleChange(agentId)
  // 收集寄给 user0 的信件。
  const letters: Array<{ from: string; content: string }> = []
  const originalDeposit = contextManager.deposit.bind(contextManager)
  contextManager.deposit = (agentId, letter, from) => {
    if (agentId === 'user0') letters.push({ from: from ?? '', content: String(letter.content) })
    return originalDeposit(agentId, letter, from)
  }

  const instance = await instances.instantiate({
    className: extra?.template !== undefined ? extra.template.name : cls.name,
    parentId: makeAgentID('user0'),
    userPrompt: 'hi',
    spaceId: makeAgentSpaceID('space-1'),
  })
  await contextManager.register({ agentId: instance.id, systemPrompt: cls.systemPrompt, onDelivery: () => {} })
  // user0 作为接收者注册（最终回复投递目标）。
  await contextManager.register({ agentId: 'user0', assemble: false, onDelivery: () => {} })

  const runtime = new DefaultRuntime({
    gateway,
    instances,
    contextManager,
    repository,
    tools: extra?.tools,
    // S6/R6：模型解析归口族谱树四级律（端口 stub；原 templates+defaultModel 单层链已拆除）。
    resolveModel: extra?.resolveModel ?? (() => model),
    // S9：类基因步数解析口 + 全局兜底 + 日志采集。
    templates: extra?.template !== undefined ? new DefaultTemplateRegistry([extra.template]) : undefined,
    ...(extra?.maxSteps !== undefined ? { maxSteps: extra.maxSteps } : {}),
    onLog: { log: (event) => { logs.push(event) } },
  })
  return { runtime, instances, contextManager, repository, letters, agentId: instance.id, logs }
}

/** 步数收束专项载体类 + 无限 tool-call 网关脚本。 */
const loopTool: AgentClass = {
  name: makeAgentClassID('looper'),
  description: 'x',
  systemPrompt: 'looper',
  tools: { tick: 'allow' },
  maxSteps: 2,
}

function endlessToolCall(counter: { n: number }) {
  return (request: { system?: string }): Iterable<import('../gateway').LLMEvent> => {
    counter.n += 1
    return [
      { type: 'tool-call', id: `t${String(counter.n)}`, name: 'tick', input: {} },
      { type: 'finish', reason: 'tool_calls' },
    ]
  }
}

describe('DefaultRuntime（被动驱动）', () => {
  test('processDelivery：LLM 文本回复 → 寄信给创建者 → holding', async () => {
    const gateway = new FakeGateway(() => [
      { type: 'text-delta', text: 'hello' },
      { type: 'usage', inputTokens: 5, outputTokens: 3 },
      { type: 'finish', reason: 'stop' },
    ])
    const { runtime, instances, letters, agentId, contextManager } = await makeRuntime(gateway)

    await runtime.processDelivery(deliveryFor(agentId))

    // 最终回复投递到创建者（user0）上下文（发原始文本，戳由管理员生成）。
    assert.equal(letters.length, 1)
    assert.equal(letters[0]?.content, 'hello')
    assert.equal((await instances.get(agentId)).status, 'holding')

    // assistant 历史自动复制到仓库
    const state = await contextManager.getState(agentId)
    assert.equal(state.messages.filter((m) => m.message.role === 'assistant').length, 1)
  })

  test('工具轮：tool_call → 执行 → 结果入会话 → 续轮 → 最终回复', async () => {
    let round = 0
    const gateway = new FakeGateway(function* () {
      round++
      if (round === 1) {
        yield { type: 'tool-call', id: 'call_1', name: 'oc_echo', input: { text: 'hi' } }
        yield { type: 'finish', reason: 'tool_calls' }
      } else {
        yield { type: 'text-delta', text: '工具完成' }
        yield { type: 'finish', reason: 'stop' }
      }
    })
    const tools = new DefaultToolCapabilityRegistry()
    await tools.register({
      id: 'oc_echo',
      description: 'echo',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      execute: (input) => ({ text: `Echo: ${(input as { text: string }).text}` }),
    })
    const { runtime, letters, agentId } = await makeRuntime(gateway, {
      tools,
      template: { ...cls, tools: { oc_echo: 'allow' } },
    })

    await runtime.processDelivery(deliveryFor(agentId))

    assert.equal(round, 2, '工具轮 + 续轮')
    assert.equal(letters.at(-1)?.content, '工具完成')
  })

  test('notifyHold → 状态 holding', async () => {
    const gateway = new FakeGateway(() => [])
    const { runtime, instances, agentId } = await makeRuntime(gateway)
    await runtime.notifyHold(agentId)
    assert.equal((await instances.get(agentId)).status, 'holding')
  })

  test('用户中断：abort() → 部分文本闭合入库 + 状态 interrupted + 可恢复', async () => {
    // 模拟慢流：产出部分文本后等待 signal 中断（真实网络流在 reader.read() 时响应 abort）。
    const gateway = new FakeGateway(async function* (_req, options) {
      yield { type: 'text-delta', text: 'partial reply' }
      yield { type: 'text-delta', text: ' more' }
      const signal = options?.signal
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(abortError())
        const onAbort = () => reject(abortError())
        signal?.addEventListener('abort', onAbort, { once: true })
        const t = setTimeout(resolve, 1000)
        signal?.addEventListener('abort', () => clearTimeout(t), { once: true })
      })
      yield { type: 'text-delta', text: '（不该出现）' }
      yield { type: 'finish', reason: 'stop' }
    })
    const { runtime, instances, contextManager, agentId } = await makeRuntime(gateway)

    const pending = runtime.processDelivery(deliveryFor(agentId))
    // 等部分文本产出后中断。
    await new Promise((resolve) => setTimeout(resolve, 20))
    runtime.abort(agentId)
    await pending

    // 状态 → interrupted（仅暂停，实例存活）。
    assert.equal((await instances.get(agentId)).status, 'interrupted')

    // 消息闭合：中断时已产出的文本补 <interrupted> 标记入库，避免非法消息序列。
    const state = await contextManager.getState(agentId)
    const assistants = state.messages.filter((m) => m.message.role === 'assistant')
    assert.equal(assistants.length, 1)
    assert.equal(assistants[0]?.message.content, 'partial reply more\n<interrupted>')

    // 可恢复：再次送信 → 状态回 thinking → 正常完成 → holding。
    const gateway2 = new FakeGateway(() => [
      { type: 'text-delta', text: 'recovered' },
      { type: 'finish', reason: 'stop' },
    ])
    const { runtime: runtime2, instances: instances2, agentId: id2 } = await makeRuntime(gateway2)
    await runtime2.processDelivery(deliveryFor(id2))
    assert.equal((await instances2.get(id2)).status, 'holding')
  })

  test('网络中断（GatewayError request_failed 非 abort）：部分文本入库 + interrupted', async () => {
    const gateway = new FakeGateway(async function* () {
      yield { type: 'text-delta', text: 'partial' }
      yield { type: 'text-delta', text: ' network' }
      throw new GatewayError({ kind: 'request_failed', message: 'Connection reset' })
    })
    const { runtime, instances, contextManager, agentId } = await makeRuntime(gateway)
    await runtime.processDelivery(deliveryFor(agentId))

    assert.equal((await instances.get(agentId)).status, 'interrupted')
    const state = await contextManager.getState(agentId)
    const assistants = state.messages.filter((m) => m.message.role === 'assistant')
    // 非主动中断：不补 <interrupted> 标记，原样保留部分文本。
    assert.equal(assistants[0]?.message.content, 'partial network')
  })

  test('中断后仓库消息完整闭合：assistant 后不直接接 user', async () => {
    const gateway = new FakeGateway(async function* (_req, options) {
      yield { type: 'text-delta', text: 'half' }
      const signal = options?.signal
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(abortError())
        const onAbort = () => reject(abortError())
        signal?.addEventListener('abort', onAbort, { once: true })
        const t = setTimeout(resolve, 1000)
        signal?.addEventListener('abort', () => clearTimeout(t), { once: true })
      })
      yield { type: 'text-delta', text: ' not delivered' }
      yield { type: 'finish', reason: 'stop' }
    })
    const { runtime, contextManager, agentId } = await makeRuntime(gateway)
    const pending = runtime.processDelivery(deliveryFor(agentId))
    await new Promise((resolve) => setTimeout(resolve, 10))
    runtime.abort(agentId)
    await pending

    // 消息闭合：仓库中 assistant（<interrupted>）后不再有脱节的 user 消息。
    // 注：delivery.messages 是 runtime 直接消费的输入（不经过仓库入库），
    // 仓库只有 register 时写入的 system + halt 收尾写入的 assistant。
    const state = await contextManager.getState(agentId)
    const roles = state.messages.map((m) => m.message.role)
    assert.deepEqual(roles, ['system', 'assistant'])
    const last = state.messages.at(-1)
    assert.equal(last?.message.content, 'half\n<interrupted>')
  })

  test('并发：多 agent 同时 processDelivery（gateway 并发调用）互不干扰', async () => {
    // 每个 agent 独立调用 gateway（AsyncGenerator 天然并发）。
    const gateways = [
      new FakeGateway(() => [{ type: 'text-delta', text: 'agent-a' }, { type: 'finish', reason: 'stop' }]),
      new FakeGateway(() => [{ type: 'text-delta', text: 'agent-b' }, { type: 'finish', reason: 'stop' }]),
    ]
    const results = await Promise.all(
      gateways.map(async (g, i) => {
        const { runtime, letters, agentId } = await makeRuntime(g)
        await runtime.processDelivery(deliveryFor(agentId))
        return { index: i, text: letters[0]?.content }
      }),
    )
    assert.deepEqual(
      results.map((r) => r.text),
      ['agent-a', 'agent-b'],
    )
  })

  test('S6/R6 无锚防御：resolveModel 落空 → 不发请求、中断本轮（model_unresolved）', async () => {
    const gateway = new FakeGateway(() => [{ type: 'text-delta', text: '不应被调用' }])
    let resolveCalls = 0
    const { runtime, agentId, instances } = await makeRuntime(gateway, {
      resolveModel: () => {
        resolveCalls++
        return undefined
      },
    })
    await runtime.processDelivery(deliveryFor(agentId))
    assert.equal(resolveCalls, 1, '解析端口被咨询一次')
    assert.equal(gateway.requests.length, 0, '无锚不得触网关')
    assert.equal(instances.getSync(makeAgentID(agentId))?.status, 'interrupted')
  })
})

describe('步数上限（S9：类基因 > 全局兜底 > 无限）', () => {
  test('类基因 maxSteps=2：两轮工具后收束并发 kernel.step.limit', async () => {
    const counter = { n: 0 }
    const tools = new DefaultToolCapabilityRegistry()
    await tools.register({
      id: 'tick',
      description: 'x',
      parameters: { type: 'object', properties: {} },
      execute: () => ({ text: 'tick' }),
    })
    const gateway = new FakeGateway(endlessToolCall(counter))
    const { runtime, agentId, logs } = await makeRuntime(gateway, { tools, template: loopTool })
    await runtime.processDelivery(deliveryFor(agentId, loopTool.systemPrompt))
    assert.equal(gateway.requests.length, 2, '类基因上限两轮')
    const ev = logs.find((e) => e.type === 'kernel.step.limit')
    assert.ok(ev && ev.type === 'kernel.step.limit' && ev.maxSteps === 2, '撞限事件行动化')
  })

  test('缺省无限制：>5 轮工具长跑不被切断（旧默认 5 的回归锚）', async () => {
    const counter = { n: 0 }
    const tools = new DefaultToolCapabilityRegistry()
    await tools.register({
      id: 'tick',
      description: 'x',
      parameters: { type: 'object', properties: {} },
      execute: () => ({ text: 'tick' }),
    })
    const seen = counter
    const gateway = new FakeGateway((request) => {
      seen.n += 1
      if (seen.n >= 7) return [{ type: 'text-delta', text: 'done' }, { type: 'finish', reason: 'stop' }]
      return [{ type: 'tool-call', id: `t${String(seen.n)}`, name: 'tick', input: {} }, { type: 'finish', reason: 'tool_calls' }]
    })
    const { runtime, agentId } = await makeRuntime(gateway, { tools })
    await runtime.processDelivery(deliveryFor(agentId))
    assert.equal(gateway.requests.length, 7, '七轮长跑无切断')
  })

  test('全局 config 兜底：无类基因时 deps.maxSteps=1 生效', async () => {
    const counter = { n: 0 }
    const tools = new DefaultToolCapabilityRegistry()
    await tools.register({
      id: 'tick',
      description: 'x',
      parameters: { type: 'object', properties: {} },
      execute: () => ({ text: 'tick' }),
    })
    const gateway = new FakeGateway(endlessToolCall(counter))
    const { runtime, agentId } = await makeRuntime(gateway, { tools, maxSteps: 1 })
    await runtime.processDelivery(deliveryFor(agentId))
    assert.equal(gateway.requests.length, 1)
  })
})
