// ============================================================
// core/kernel/AgentRuntime.test.ts —— 运行时（FakeGateway，无网络）
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeGateway, textEvents } from '../gateway'
import type { LLMRequest } from '../gateway'
import { DefaultAgentTemplateRegistry } from './AgentTemplateRegistry'
import { DefaultAgentInstanceManager } from './AgentInstanceManager'
import { DefaultAgentSpaceManager } from './AgentSpaceManager'
import { DefaultAgentRuntime } from './AgentRuntime'
import type { AgentClass } from './types'
import { makeAgentClassID, makeAgentID } from './types'

const cls: AgentClass = {
  id: makeAgentClassID('chat'),
  name: 'Chat',
  description: 'chat agent',
  systemPrompt: 'You are assistant.',
  tools: [],
  permission: 'normal',
  memoryScope: [],
}

const model = { provider: 'opencode', id: 'test-model' }

async function makeRuntime(gateway: FakeGateway, extra?: { maxSteps?: number }) {
  const templates = new DefaultAgentTemplateRegistry([cls])
  const instances = new DefaultAgentInstanceManager(templates)
  const spaces = new DefaultAgentSpaceManager()
  const space = await spaces.getOrCreate('/proj')
  const agent = await instances.instantiate(cls.id, { spaceId: space.id })
  const runtime = new DefaultAgentRuntime({ gateway, instances, templates, defaultModel: model, maxSteps: extra?.maxSteps })
  return { runtime, instances, agent }
}

describe('DefaultAgentRuntime', () => {
  test('文本对话：system 生效、历史累积、usage 返回、状态复位', async () => {
    const gateway = new FakeGateway((request: LLMRequest) => {
      // 首轮只有 1 条 user；第二轮带上一轮 assistant
      const users = request.messages.filter((m) => m.role === 'user').length
      return textEvents(`reply-${users}`, { inputTokens: 20, outputTokens: 5 })
    })
    const { runtime, instances, agent } = await makeRuntime(gateway)

    const r1 = await runtime.run(agent.id, 'hi')
    assert.equal(r1.text, 'reply-1')
    assert.equal(r1.finishReason, 'stop')
    assert.equal(r1.turnCount, 1)

    const r2 = await runtime.run(agent.id, 'again')
    assert.equal(r2.text, 'reply-2')

    // 第二轮请求必须携带第一轮历史
    const last = gateway.requests.at(-1)
    assert.ok(last)
    assert.equal(last.system, 'You are assistant.')
    assert.equal(last.messages.length, 3) // system 单独字段，messages 为 user/assistant/user

    // 实例历史与状态
    const instance = await instances.get(agent.id)
    assert.equal(instance.history.length, 4)
    assert.equal(instance.turnCount, 2)
    assert.equal(instance.status, 'idle')
    assert.equal(instance.totalCost, 0)
  })

  test('成本估算注入生效', async () => {
    const gateway = new FakeGateway(() => textEvents('ok', { inputTokens: 10, outputTokens: 3 }))
    const templates = new DefaultAgentTemplateRegistry([cls])
    const instances = new DefaultAgentInstanceManager(templates)
    const space = await new DefaultAgentSpaceManager().getOrCreate('/proj')
    const agent = await instances.instantiate(cls.id, { spaceId: space.id })
    const runtime = new DefaultAgentRuntime({
      gateway,
      instances,
      templates,
      defaultModel: model,
      estimateCost: (usage) => ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)) / 1000,
    })
    await runtime.run(agent.id, 'hi')
    const instance = await instances.get(agent.id)
    assert.equal(instance.totalCost, (10 + 3) / 1000)
  })

  test('onEvent 透传流式事件', async () => {
    const gateway = new FakeGateway(() => textEvents('hello'))
    const { runtime, agent } = await makeRuntime(gateway)
    const seen: string[] = []
    await runtime.run(agent.id, 'hi', { onEvent: (e) => seen.push(e.type) })
    assert.ok(seen.includes('text-delta'))
    assert.ok(seen.includes('usage'))
    assert.ok(seen.includes('finish'))
  })

  test('工具调用：记录 toolCalls 并回写 assistant 历史，单轮结束', async () => {
    const gateway = new FakeGateway(function* () {
      yield { type: 'tool-call', id: 'call_1', name: 'get_weather', input: { city: 'beijing' } }
      yield { type: 'usage', inputTokens: 9, outputTokens: 4 }
      yield { type: 'finish', reason: 'tool_calls' }
    })
    const { runtime, instances, agent } = await makeRuntime(gateway)
    const result = await runtime.run(agent.id, 'weather?')
    assert.equal(result.finishReason, 'tool_calls')
    assert.equal(result.toolCalls.length, 1)
    assert.equal(result.toolCalls[0]?.name, 'get_weather')

    const instance = await instances.get(agent.id)
    const assistant = instance.history.at(-1)
    assert.equal(assistant?.role, 'assistant')
  })
})
