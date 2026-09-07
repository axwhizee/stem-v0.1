// ============================================================
// core/kernel/Kernel.test.ts —— 集成测试（邮局模式）
//
// 覆盖：简单对话闭环 / 发送者戳 / 状态机 / 邮局信件累积 /
// 工具轮（含 onRecord 自动记录）/ user0 与 agent 一视同仁。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeGateway, textEvents, abortError } from '../gateway'
import type { LLMRequest } from '../gateway'
import type { AgentClass } from './types'
import { makeAgentClassID, makeAgentID } from './types'
import { createKernelHarness } from '../../../test/support/kernelHarness'
import { BUILTIN_TEMPLATES, USER_ID } from './Kernel'

const _model = { provider: 'opencode', id: 'test-model' }

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** 带工具白名单的模板（供工具轮测试）。 */
const toolAssistant: AgentClass = {
  name: makeAgentClassID('tool-agent'),
  description: '带工具 agent',
  systemPrompt: 'You are an assistant with tools.',
  tools: { oc_echo: 'allow' },
}

const templatesWithTool = [...BUILTIN_TEMPLATES, toolAssistant]

describe('Kernel 邮局模式', () => {
  test('简单对话闭环：user0 发消息 → agent 回复 → user0 收到发送者戳消息', async () => {
    const gateway = new FakeGateway(() => textEvents('hello'))
    const { kernel, deliveries } = await createKernelHarness(gateway)
    const agentId = await kernel.getOrCreateAgent(makeAgentClassID('assistant'), '/proj')

    await kernel.sendUserMessage(agentId, 'hi')
    const delivery = (await deliveries.next())!

    assert.equal(delivery.kind, 'user')
    const letter = delivery.letters[0]
    assert.equal(letter?.content, `<sender id="${agentId}">hello</sender>`)

    const instance = await kernel.instances.get(agentId)
    assert.equal(instance.turnCount, 1)
  })

  test('状态机：thinking → holding（倒计时结束无信保持 holding）', async () => {
    const gateway = new FakeGateway(() => textEvents('ok'))
    const { kernel, deliveries, timers } = await createKernelHarness(gateway)
    const agentId = await kernel.instantiateAgent(
      { className: makeAgentClassID('assistant'), parentId: makeAgentID(USER_ID), userPrompt: 'hello' },
      '/proj',
    )

    // 首信立即送信（初始倒计时 0）→ agent thinking → 回复 → holding
    await deliveries.next()
    assert.equal((await kernel.instances.get(agentId)).status, 'holding')

    // 倒计时结束无信 → 保持 holding（等待）
    timers.flushAll()
    await tick()
    assert.equal((await kernel.instances.get(agentId)).status, 'holding')

    // holding 中再来信 → 立即唤醒
    await kernel.sendUserMessage(agentId, 'again')
    await deliveries.next()
  })

  test('邮局累积：cooldown 期间多封信合并为一次送信', async () => {
    const gateway = new FakeGateway(() => textEvents('ok'))
    const { kernel, deliveries, timers } = await createKernelHarness(gateway)
    const agentId = await kernel.getOrCreateAgent(makeAgentClassID('assistant'), '/proj')

    // 首信（立即送信）
    await kernel.sendUserMessage(agentId, 'first')
    await deliveries.next()
    assert.ok(timers.count() >= 1, '送信后开始倒计时（agent + user0 信箱）')

    // cooldown 期间两封信 → 合并
    await kernel.sendUserMessage(agentId, 'second')
    await kernel.sendUserMessage(agentId, 'third')
    timers.flushAll()
    await deliveries.next()

    // 历史应包含：默认首信 + first + second + third，且 second/third 合并为一次回复
    const state = await kernel.contextManager.getState(agentId)
    const userContents = state.messages.filter((m) => m.message.role === 'user').map((m) => m.message.content)
    assert.equal(userContents.length, 4, '默认首信 + 三次用户消息')
    // 管理员统一打发送者戳（from=user0）。
    assert.deepEqual(userContents.slice(1), [
      '<sender id="user0">first</sender>',
      '<sender id="user0">second</sender>',
      '<sender id="user0">third</sender>',
    ])
    assert.equal(state.messages.filter((m) => m.message.role === 'assistant').length, 2)
  })

  test('工具轮：tool_call → 执行 → 结果入上下文 → 模型续轮；onRecord 自动记录', async () => {
    let round = 0
    const gateway = new FakeGateway(function* () {
      round++
      if (round === 1) {
        yield { type: 'tool-call', id: 'call_1', name: 'oc_echo', input: { text: 'hi' } }
        yield { type: 'finish', reason: 'tool_calls' }
      } else {
        yield { type: 'text-delta', text: '工具返回了' }
        yield { type: 'finish', reason: 'stop' }
      }
    })
    const { kernel, deliveries, tools, timers } = await createKernelHarness(gateway, { templates: templatesWithTool })
    await tools.register({
      id: 'oc_echo',
      birth: 'ignore',
      description: 'echo',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      execute: (input) => ({ text: `Echo: ${(input as { text: string }).text}` }),
    })
    const agentId = await kernel.getOrCreateAgent(makeAgentClassID('tool-agent'), '/proj')

    // 消费首信回复（默认 userPrompt）
    await deliveries.next()

    await kernel.sendUserMessage(agentId, 'echo hi')
    timers.flushAll()
    const delivery = (await deliveries.next())!
    assert.equal(delivery.letters[0]?.content, `<sender id="${agentId}">工具返回了</sender>`)

    // onRecord 自动记录（called + success）已入邮局（tool 结果消息进入仓库）
    const state = await kernel.contextManager.getState(agentId)
    // tool 结果自动进入仓库（工具模块发送，非 runtime 手动）
    assert.ok(state.messages.some((m) => m.message.role === 'tool' && m.message.content === 'Echo: hi'))
  })

  test('并行工具调用：一次 assistant 多个 tool_call 并行执行', async () => {
    let round = 0
    const gateway = new FakeGateway(function* () {
      round++
      if (round === 1) {
        yield { type: 'tool-call', id: 'call_1', name: 'oc_echo', input: { text: 'a' } }
        yield { type: 'tool-call', id: 'call_2', name: 'oc_echo', input: { text: 'b' } }
        yield { type: 'finish', reason: 'tool_calls' }
      } else {
        yield { type: 'text-delta', text: 'done' }
        yield { type: 'finish', reason: 'stop' }
      }
    })
    const { kernel, deliveries, tools, timers } = await createKernelHarness(gateway, { templates: templatesWithTool })
    const executed: string[] = []
    await tools.register({
      id: 'oc_echo',
      birth: 'ignore',
      description: 'echo',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      execute: (input) => {
        executed.push((input as { text: string }).text)
        return { text: `Echo: ${(input as { text: string }).text}` }
      },
    })
    const agentId = await kernel.getOrCreateAgent(makeAgentClassID('tool-agent'), '/proj')

    // 消费首信回复
    await deliveries.next()

    await kernel.sendUserMessage(agentId, 'echo a and b')
    timers.flushAll()
    await deliveries.next()
    assert.deepEqual(executed.sort(), ['a', 'b'])

    const state = await kernel.contextManager.getState(agentId)
    assert.equal(state.messages.filter((m) => m.message.role === 'tool').length, 2)
  })

  test('tool 白名单隔离：无权限模板不会把时间工具物化给 LLM', async () => {
    let lastRequest: LLMRequest | undefined
    const gateway = new FakeGateway((request: LLMRequest) => {
      lastRequest = request
      return textEvents('ok')
    })
    const { kernel, tools, deliveries, timers } = await createKernelHarness(gateway)
    await tools.register({
      id: 'oc_get_time',
      birth: 'ignore',
      description: 'get time',
      parameters: { type: 'object', properties: {} },
      execute: () => ({ text: 'now' }),
    })
    // 局部封闭类（tools={} → 本地全 deny；internal 占位 assistant 是「继承」形，非封闭）
    await kernel.templates.register({ name: makeAgentClassID('closed'), description: 'closed', systemPrompt: 's', tools: {} })
    const agentId = await kernel.getOrCreateAgent(makeAgentClassID('closed'), '/proj')
    await deliveries.next() // 首信回复

    await kernel.sendUserMessage(agentId, 'what time')
    timers.flushAll()
    await deliveries.next()
    assert.ok(!lastRequest?.tools || lastRequest.tools.length === 0, '白名单空 → 不物化工具')
  })

  test('系统工具：agent_class_create/list（admin）创建类，且类不含实例数据', async () => {
    const gateway = new FakeGateway(() => textEvents('ok'))
    // user 类清单显式声明管理工具 = user0 生效权限（族谱台账物化，白名单语义）。
    const { kernel, tools } = await createKernelHarness(gateway, {
      userClass: {
        tools: {
          agent_class_create: 'allow',
          agent_class_list: 'allow',
          agent_instantiate: 'allow',
        },
      },
    })
    await kernel.registerSystemTools(tools)

    // user0 身份调用：registry/ask 总线经 AccessResolver 查询台账（不再手传权限层）。
    const adminCtx = { agentId: USER_ID, spaceId: 'space-1' }

    const created = await tools.execute(
      {
        id: 'call_1',
        name: 'agent_class_create',
        input: {
          name: 'reviewer',
          description: '代码审查',
          systemPrompt: 'You review code.',
          tools: { read: 'allow' },
        },
      },
      adminCtx,
    )
    assert.match(created.text, /已创建 agent 类 reviewer/)

    const cls = await kernel.templates.get(makeAgentClassID('reviewer'))
    assert.equal(cls.name, 'reviewer')
    assert.deepEqual(cls.tools, { read: 'allow' })
    assert.ok(!('userPrompt' in cls), '类只承载设定参数，不含实例数据')

    const listed = await tools.execute({ id: 'call_2', name: 'agent_class_list', input: {} }, adminCtx)
    assert.match(listed.text, /reviewer/)

    // 新类可直接实例化（agent_instantiate 仍要求 className + userPrompt）
    const inst = await tools.execute(
      { id: 'call_3', name: 'agent_instantiate', input: { className: 'reviewer', userPrompt: 'review this' } },
      adminCtx,
    )
    assert.match(inst.text, /已创建 agent/)

    // 白名单隔离：封闭清单类（tools={}）的 agent 调管理工具 → deny
    await kernel.templates.register({ name: makeAgentClassID('closed'), description: 'closed', systemPrompt: 's', tools: {} })
    const closedAgent = await kernel.getOrCreateAgent(makeAgentClassID('closed'), '/proj')
    await assert.rejects(
      () =>
        tools.execute(
          {
            id: 'call_4',
            name: 'agent_class_create',
            input: { name: 'X', description: 'x', systemPrompt: 'x' },
          },
          { agentId: closedAgent, spaceId: 'space-1' },
        ),
      (e: { kind?: string }) => e.kind === 'access_denied',
    )
  })

  test('logging：全链路日志经消息总线路由到记录器', async () => {
    const gateway = new FakeGateway(() => textEvents('ok'))
    const { kernel, tools, timers, deliveries } = await createKernelHarness(gateway)
    await kernel.registerSystemTools(tools)

    const agentId = await kernel.getOrCreateAgent(makeAgentClassID('assistant'), '/proj')
    await deliveries.next() // 首信回复
    await kernel.sendUserMessage(agentId, 'hi')
    timers.flushAll()
    await deliveries.next()

    const logs = kernel.logger.all()
    const has = (type: string) => logs.some((e) => e.type === type)
    assert.ok(has('kernel.instance.created'), '实例创建')
    assert.ok(has('kernel.status.changed'), '状态变化')
    assert.ok(has('kernel.message.sent'), '总线消息')
    assert.ok(has('gateway.apiRequest'), '模型调用 + token')
    assert.ok(has('context.assembled'), '上下文拼装留档')
    assert.ok(has('mailbox.countdown'), '倒计时状态')
    assert.ok(has('mailbox.delivered'), '发送状态')

    // 按 agentId 过滤查询
    const agentLogs = kernel.logger.query({ agentId })
    assert.ok(agentLogs.length > 0)
    assert.ok(agentLogs.every((e) => e.type !== 'kernel.class.registered'))

    // 上下文留档包含 messages 快照
    const assembled = kernel.logger.query({ type: 'context.assembled' })[0] as { messages: readonly unknown[] }
    assert.ok(Array.isArray(assembled.messages))

    // 工具调用日志（tool.invoked：called/success/error）——
    // 类清单显式声明 oc_echo（白名单语义下"声明即可用"，经台账查询）。
    await tools.register({
      id: 'oc_echo',
      birth: 'ignore',
      description: 'echo',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      execute: (input) => ({ text: `Echo: ${(input as { text: string }).text}` }),
    })
    await kernel.registerAgentClass({
      name: makeAgentClassID('echo-user'),
      description: 'echo 使用者',
      systemPrompt: 'echo-user',
      tools: { oc_echo: 'allow' },
    })
    const echoAgentId = await kernel.getOrCreateAgent(makeAgentClassID('echo-user'), '/proj')
    await tools.execute({ id: 'call_5', name: 'oc_echo', input: { text: 'hi' } }, { agentId: echoAgentId, spaceId: 'space-1' })
    const toolLogs = kernel.logger.query({ type: 'tool.invoked' })
    assert.ok(toolLogs.some((e) => (e as { phase?: string }).phase === 'called'))
    assert.ok(
      toolLogs.some(
        (e) => (e as { phase?: string; resultText?: string }).phase === 'success' && (e as { resultText?: string }).resultText === 'Echo: hi',
      ),
    )
  })

  test('中断：user0 中断活跃 agent → interrupted + 消息闭合；非祖先中断被拒', async () => {
    // 慢流网关：产出部分文本后等待 signal（模拟网络流）。
    const gateway = new FakeGateway(async function* (_req, options) {
      yield { type: 'text-delta', text: 'partial' }
      const signal = options?.signal
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(abortError())
        const onAbort = () => reject(abortError())
        signal?.addEventListener('abort', onAbort, { once: true })
        const t = setTimeout(resolve, 2000)
        signal?.addEventListener('abort', () => clearTimeout(t), { once: true })
      })
      yield { type: 'finish', reason: 'stop' }
    })
    const { kernel, timers } = await createKernelHarness(gateway)
    const agentId = await kernel.getOrCreateAgent(makeAgentClassID('assistant'), '/proj')

    // 等待 agent 进入 thinking（processDelivery 已开始，gateway 挂起等 signal）。
    await waitForStatus(kernel, agentId, 'thinking')

    // user0 中断（当前活跃 agent）。
    await kernel.interruptAgent(agentId as string, { by: USER_ID })
    await new Promise((resolve) => setTimeout(resolve, 20))

    const instance = await kernel.instances.get(agentId)
    assert.equal(instance.status, 'interrupted')

    // 消息闭合：仓库最后一条是带 <interrupted> 的 assistant。
    const state = await kernel.contextManager.getState(agentId)
    const last = state.messages.at(-1)
    assert.equal(last?.message.role, 'assistant')
    assert.match(String(last?.message.content), /partial\n<interrupted>/)

    // 非祖先（游离 agent）中断被拒（销毁权复用）。
    await assert.rejects(
      () => kernel.interruptAgent(agentId as string, { by: 'outsider' }),
      (e: unknown) => (e as { kind: string }).kind === 'agent_terminate_denied',
    )

    // 恢复：继续对话（倒计时 flush）→ 状态离开 interrupted（进入新一轮 thinking）。
    await kernel.sendUserMessage(agentId, '继续')
    timers.flushAll()
    await waitForStatus(kernel, agentId, 'thinking', 500)
    const recovered = await kernel.instances.get(agentId)
    assert.equal(recovered.status, 'thinking', '恢复后应重新进入 thinking')
  })
})

/** 轮询等待实例进入指定状态（避免依赖固定超时时序）。 */
async function waitForStatus(kernel: import('./Kernel').Kernel, agentId: string, status: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const instance = await kernel.instances.get(agentId as never)
    if (instance.status === status) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`等待状态 ${status} 超时（当前 ${(await kernel.instances.get(agentId as never)).status}）`)
}
