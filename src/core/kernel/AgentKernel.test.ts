// ============================================================
// core/kernel/AgentKernel.test.ts —— 集成测试（邮局模式）
//
// 覆盖：简单对话闭环 / 发送者戳 / 状态机 / 邮局信件累积 /
// 工具轮（含 onRecord 自动记录）/ user0 与 agent 一视同仁。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeGateway, textEvents } from '../gateway'
import type { LLMRequest } from '../gateway'
import type { AgentClass } from './types'
import { makeAgentClassID } from './types'
import { createKernelHarness } from '../../../test-support/kernelHarness'
import { BUILTIN_TEMPLATES, USER_ID } from './AgentKernel'

const model = { provider: 'opencode', id: 'test-model' }

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** 带工具白名单的模板（供工具轮测试）。 */
const toolAssistant: AgentClass = {
  id: makeAgentClassID('tool-agent'),
  name: 'ToolAgent',
  description: '带工具 agent',
  systemPrompt: 'You are an assistant with tools.',
  tools: [{ id: 'oc_echo' }],
  permission: 'normal',
  memoryScope: [],
}

const templatesWithTool = [...BUILTIN_TEMPLATES, toolAssistant]

describe('AgentKernel 邮局模式', () => {
  test('简单对话闭环：user0 发消息 → agent 回复 → user0 收到发送者戳消息', async () => {
    const gateway = new FakeGateway(() => textEvents('hello'))
    const { kernel, deliveries } = await createKernelHarness(gateway)
    const agentId = await kernel.getOrCreateAgent(makeAgentClassID('simple-chat'), '/proj')

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
      { classId: makeAgentClassID('simple-chat'), creatorId: USER_ID, userPrompt: 'hello' },
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
    const agentId = await kernel.getOrCreateAgent(makeAgentClassID('simple-chat'), '/proj')

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
    const userContents = state.context.filter((m) => m.role === 'user').map((m) => m.content)
    assert.equal(userContents.length, 4, '默认首信 + 三次用户消息')
    assert.deepEqual(userContents.slice(1), ['first', 'second', 'third'])
    assert.equal(state.context.filter((m) => m.role === 'assistant').length, 2)
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
      description: 'echo',
      permission: 'normal',
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

    // onRecord 自动记录（called + success）已入邮局
    const state = await kernel.contextManager.getState(agentId)
    assert.ok(state.toolRecords.some((r) => r.status === 'called'))
    assert.ok(state.toolRecords.some((r) => r.status === 'success' && r.result?.text === 'Echo: hi'))
    // tool 结果自动进入历史（工具模块发送，非 runtime 手动）
    assert.ok(state.context.some((m) => m.role === 'tool' && m.content === 'Echo: hi'))
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
      description: 'echo',
      permission: 'normal',
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
    assert.equal(state.context.filter((m) => m.role === 'tool').length, 2)
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
      description: 'get time',
      permission: 'normal',
      parameters: { type: 'object', properties: {} },
      execute: () => ({ text: 'now' }),
    })
    // 用 simple-chat（tools 白名单为空数组 → 无工具）
    const agentId = await kernel.getOrCreateAgent(makeAgentClassID('simple-chat'), '/proj')
    await deliveries.next() // 首信回复

    await kernel.sendUserMessage(agentId, 'what time')
    timers.flushAll()
    await deliveries.next()
    assert.ok(!lastRequest?.tools || lastRequest.tools.length === 0, '白名单空 → 不物化工具')
  })

  test('系统工具：agent_class_create/list（admin）创建类，且类不含实例数据', async () => {
    const gateway = new FakeGateway(() => textEvents('ok'))
    const { kernel, tools } = await createKernelHarness(gateway)
    await kernel.registerSystemTools(tools)

    // admin 权限上下文（创建类需 admin；实例化需 advanced）。
    const adminCtx = { agentId: USER_ID, spaceId: 'space-1', agentPermission: 'admin' as const }

    const created = await tools.execute(
      {
        id: 'call_1',
        name: 'agent_class_create',
        input: {
          id: 'reviewer',
          name: 'Reviewer',
          description: '代码审查',
          systemPrompt: 'You review code.',
          permission: 'advanced',
          tools: ['oc_echo'],
        },
      },
      adminCtx,
    )
    assert.match(created.text, /已创建 agent 类 reviewer/)

    const cls = await kernel.templates.get(makeAgentClassID('reviewer'))
    assert.equal(cls.name, 'Reviewer')
    assert.equal(cls.permission, 'advanced')
    assert.equal(cls.tools[0]?.id, 'oc_echo')
    assert.ok(!('userPrompt' in cls), '类只承载设定参数，不含实例数据')

    const listed = await tools.execute({ id: 'call_2', name: 'agent_class_list', input: {} }, adminCtx)
    assert.match(listed.text, /reviewer/)

    // 新类可直接实例化（agent_instantiate 仍要求 classId + userPrompt）
    const inst = await tools.execute(
      { id: 'call_3', name: 'agent_instantiate', input: { classId: 'reviewer', userPrompt: 'review this' } },
      adminCtx,
    )
    assert.match(inst.text, /已创建 agent/)

    // 权限校验：normal 无权创建类
    const normalCtx = { agentId: 'some-agent', spaceId: 'space-1', agentPermission: 'normal' as const }
    await assert.rejects(
      () =>
        tools.execute(
          {
            id: 'call_4',
            name: 'agent_class_create',
            input: { id: 'x', name: 'X', description: 'x', systemPrompt: 'x' },
          },
          normalCtx,
        ),
      (e: { kind?: string }) => e.kind === 'permission_denied',
    )
  })

  test('logging：全链路日志经消息总线路由到记录器', async () => {
    const gateway = new FakeGateway(() => textEvents('ok'))
    const { kernel, tools, timers, deliveries } = await createKernelHarness(gateway)
    await kernel.registerSystemTools(tools)

    const agentId = await kernel.getOrCreateAgent(makeAgentClassID('simple-chat'), '/proj')
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

    // 工具调用日志（tool.invoked：called/success/error）
    await tools.register({
      id: 'oc_echo',
      description: 'echo',
      permission: 'normal',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      execute: (input) => ({ text: `Echo: ${(input as { text: string }).text}` }),
    })
    const normalCtx = { agentId, spaceId: 'space-1', agentPermission: 'normal' as const }
    await tools.execute({ id: 'call_5', name: 'oc_echo', input: { text: 'hi' } }, normalCtx)
    const toolLogs = kernel.logger.query({ type: 'tool.invoked' })
    assert.ok(toolLogs.some((e) => (e as { phase?: string }).phase === 'called'))
    assert.ok(
      toolLogs.some(
        (e) => (e as { phase?: string; resultText?: string }).phase === 'success' && (e as { resultText?: string }).resultText === 'Echo: hi',
      ),
    )
  })
})
