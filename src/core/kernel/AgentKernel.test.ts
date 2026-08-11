// ============================================================
// core/kernel/AgentKernel.test.ts —— 容器（Scheduler 最小直通）
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeGateway, textEvents } from '../gateway'
import type { LLMRequest } from '../gateway'
import { AgentKernel } from './AgentKernel'
import { makeAgentClassID, makeAgentID } from './types'

const model = { provider: 'opencode', id: 'test-model' }

describe('AgentKernel', () => {
  test('getOrCreateAgent：同空间同模板复用，不同空间新建', async () => {
    const gateway = new FakeGateway(() => textEvents('ok'))
    const kernel = new AgentKernel({ gateway, defaultModel: model })

    const id1 = await kernel.getOrCreateAgent(makeAgentClassID('simple-chat'), '/proj-A')
    const id2 = await kernel.getOrCreateAgent(makeAgentClassID('simple-chat'), '/proj-A')
    assert.equal(id1, id2, '同空间同模板应复用')

    const id3 = await kernel.getOrCreateAgent(makeAgentClassID('simple-chat'), '/proj-B')
    assert.notEqual(id1, id3, '不同空间应新建')

    assert.equal((await kernel.instances.listBySpace('space-1' as never)).length, 1)
  })

  test('run：kernel → scheduler → agent.run 通路打通', async () => {
    const gateway = new FakeGateway((request: LLMRequest) => {
      assert.equal(request.system, 'You are a helpful assistant. Answer concisely.')
      return textEvents('hello from kernel', { inputTokens: 5, outputTokens: 3 })
    })
    const kernel = new AgentKernel({ gateway, defaultModel: model })
    const agentId = await kernel.getOrCreateAgent(makeAgentClassID('simple-chat'), '/proj')

    const result = await kernel.run(agentId, 'hi')
    assert.equal(result.text, 'hello from kernel')
    assert.equal(result.usage?.inputTokens, 5)
  })

  test('内置模板已注册（templates/*.json 装配）', async () => {
    const gateway = new FakeGateway(() => textEvents('ok'))
    const kernel = new AgentKernel({ gateway, defaultModel: model })
    const ids = (await kernel.templates.list()).map((t) => t.id)
    assert.ok(ids.includes(makeAgentClassID('simple-chat')))
    assert.ok(ids.includes(makeAgentClassID('coder')))
  })
})
