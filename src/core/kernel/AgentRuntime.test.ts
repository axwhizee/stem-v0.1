// ============================================================
// core/kernel/AgentRuntime.test.ts —— 运行时单元测试（被动驱动）
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeGateway } from '../gateway'
import { DefaultMessageBus } from '../bus'
import { ClassicContextAssembler, DefaultContextManager } from '../context'
import type { AgentDelivery } from '../context'
import { DefaultToolCapabilityRegistry } from '../tools'
import type { BusSendInput } from '../bus'
import { DefaultAgentTemplateRegistry } from './AgentTemplateRegistry'
import { DefaultAgentInstanceManager } from './AgentInstanceManager'
import { DefaultAgentRuntime } from './AgentRuntime'
import type { AgentClass } from './types'
import { makeAgentClassID, makeAgentSpaceID } from './types'

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

function deliveryFor(agentId: string, system = cls.systemPrompt): AgentDelivery {
  return { kind: 'agent', agentId, system, messages: [{ role: 'user', content: 'hi' }] }
}

async function makeRuntime(gateway: FakeGateway, extra?: { tools?: DefaultToolCapabilityRegistry; template?: AgentClass }) {
  const templates = new DefaultAgentTemplateRegistry([extra?.template ?? cls])
  const instances = new DefaultAgentInstanceManager(templates)
  const contextManager = new DefaultContextManager({ assembler: new ClassicContextAssembler() })
  const sent: BusSendInput[] = []
  const bus = new DefaultMessageBus({ forward: async (msg) => void sent.push(msg) })

  const instance = await instances.instantiate({
    classId: cls.id,
    creatorId: 'user0',
    userPrompt: 'hi',
    spaceId: makeAgentSpaceID('space-1'),
  })
  await contextManager.register({ agentId: instance.id, systemPrompt: cls.systemPrompt, onDelivery: () => {} })

  const runtime = new DefaultAgentRuntime({
    gateway,
    instances,
    templates,
    contextManager,
    bus,
    tools: extra?.tools,
    defaultModel: model,
  })
  return { runtime, instances, contextManager, sent, agentId: instance.id }
}

describe('DefaultAgentRuntime（被动驱动）', () => {
  test('processDelivery：LLM 文本回复 → 加发送者戳 → 寄信给创建者 → holding', async () => {
    const gateway = new FakeGateway(() => [
      { type: 'text-delta', text: 'hello' },
      { type: 'usage', inputTokens: 5, outputTokens: 3 },
      { type: 'finish', reason: 'stop' },
    ])
    const { runtime, instances, sent, agentId, contextManager } = await makeRuntime(gateway)

    await runtime.processDelivery(deliveryFor(agentId))

    const msg = sent.at(-1)
    assert.ok(msg)
    assert.equal(msg.to, 'user0')
    assert.equal(msg.payload, `<sender id="${agentId}">hello</sender>`)
    assert.equal((await instances.get(agentId)).status, 'holding')

    // assistant 历史自动复制到邮局
    const state = contextManager.getState(agentId)
    assert.equal(state.context.filter((m) => m.role === 'assistant').length, 1)
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
      permission: 'normal',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      execute: (input) => ({ text: `Echo: ${(input as { text: string }).text}` }),
    })
    const { runtime, sent, agentId } = await makeRuntime(gateway, {
      tools,
      template: { ...cls, tools: [{ id: 'oc_echo' }] },
    })

    await runtime.processDelivery(deliveryFor(agentId))

    assert.equal(round, 2, '工具轮 + 续轮')
    assert.equal(sent.at(-1)?.payload, `<sender id="${agentId}">工具完成</sender>`)
  })

  test('notifyHold → 状态 holding', async () => {
    const gateway = new FakeGateway(() => [])
    const { runtime, instances, agentId } = await makeRuntime(gateway)
    await runtime.notifyHold(agentId)
    assert.equal((await instances.get(agentId)).status, 'holding')
  })
})
