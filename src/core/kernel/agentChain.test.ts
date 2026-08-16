// ============================================================
// core/kernel/agentChain.test.ts —— 端到端测试任务
//
// 验收场景：
//   用户 → 创造者(无时间权限) → agent_instantiate 创建子 agent
//   （带 userPrompt「读取当前时间」）→ 创造者 context_wait(子agent)
//   → 子 agent 读时间 → 自动回信 → 邮局将回信作为 context_wait
//   的 tool 结果填充 → 创造者收到后回复用户时间。
//
// 验证点：creatorId 传递、权限白名单隔离、实例化返回 id、
// context_wait 等待填充、回信作为 tool 结果而非信件、发送者戳。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeGateway } from '../gateway'
import type { LLMRequest, LLMEvent } from '../gateway'
import type { AgentClass } from './types'
import { makeAgentClassID, makeAgentID } from './types'
import { BUILTIN_TEMPLATES, USER_ID } from './Kernel'
import { createKernelHarness } from '../../../test-support/kernelHarness'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const creatorTemplate: AgentClass = {
  name: makeAgentClassID('creator'),
  description: '能创建子 agent 的调度者',
  systemPrompt: 'creator-sys: 你是调度者，可以创建子 agent 获取信息。',
  tools: {
    agent_instantiate: 'allow',
    agent_list: 'allow',
    context_wait: 'allow',
    bus_send: 'allow',
    bus_participants: 'allow',
  },
}

const toolAgentTemplate: AgentClass = {
  name: makeAgentClassID('tool-agent'),
  description: '带时间工具的助手',
  systemPrompt: 'tool-sys: 你是执行者，可以用工具查询信息并回复。',
  tools: { oc_get_time: 'allow', bus_send: 'allow', bus_participants: 'allow' },
}

describe('agent 链：用户 → 创造者 → 子 agent（读时间）→ context_wait 回传 → 用户', () => {
  test('端到端：agent_instantiate + context_wait 完成取时间闭环', async () => {
    // 按 system 区分角色，按轮次推进
    const rounds = new Map<string, number>()
    const handler = function* (request: LLMRequest): Generator<LLMEvent> {
      const key = (request.system ?? '').startsWith('creator-sys') ? 'creator' : 'tool'
      const round = rounds.get(key) ?? 0
      rounds.set(key, round + 1)

      if (key === 'creator') {
        if (round === 0) {
          yield { type: 'tool-call', id: 'ccall-0', name: 'agent_instantiate', input: { className: 'tool-agent', userPrompt: '请读取当前时间，然后把时间告诉我。', agentId: 'sub1' } }
          yield { type: 'finish', reason: 'tool_calls' }
        } else if (round === 1) {
          yield { type: 'tool-call', id: 'ccall-1', name: 'context_wait', input: { agentId: 'sub1' } }
          yield { type: 'finish', reason: 'tool_calls' }
        } else if (round === 2) {
          yield { type: 'text-delta', text: '已等待子 agent 回复。' }
          yield { type: 'finish', reason: 'stop' }
        } else {
          yield { type: 'text-delta', text: '子agent 报告当前时间是 12:00:00' }
          yield { type: 'finish', reason: 'stop' }
        }
      } else {
        if (round === 0) {
          yield { type: 'tool-call', id: `tcall-${round}`, name: 'oc_get_time', input: {} }
          yield { type: 'finish', reason: 'tool_calls' }
        } else {
          yield { type: 'text-delta', text: '当前时间是 12:00:00' }
          yield { type: 'finish', reason: 'stop' }
        }
      }
    }
    const gateway = new FakeGateway(handler)

    const { kernel, deliveries, tools, timers } = await createKernelHarness(gateway, {
      templates: [...BUILTIN_TEMPLATES, creatorTemplate, toolAgentTemplate],
    })
    await tools.register({
      id: 'oc_get_time',
      description: 'get time',
      parameters: { type: 'object', properties: {} },
      execute: () => ({ text: '当前 UTC 时间: 2026-08-11T12:00:00.000Z' }),
    })
    await kernel.registerSystemTools(tools)

    // 用户创建创造者（无时间权限）
    const creatorId = await kernel.instantiateAgent(
      { className: makeAgentClassID('creator'), parentId: makeAgentID(USER_ID), userPrompt: '请创建一个能读取时间的助手并让它把时间报告给我。' },
      '/proj',
    )

    // 第 1 封：创造者创建子 agent + context_wait 后回复"已等待"
    const first = (await deliveries.next())!
    const firstLetter = first.letters[0]
    assert.ok(
      typeof firstLetter?.content === 'string' && firstLetter.content.includes('已等待'),
      `第一封信应为"已等待"，实际: ${JSON.stringify(firstLetter?.content)}`,
    )

    // 子 agent 完成 → 自动回信 → 邮局填充 context_wait 的 tool 结果 → 创造者再次送信
    timers.flushAll()
    await tick()
    const second = (await deliveries.next())!
    const secondLetter = second.letters[0]
    assert.ok(secondLetter, '应收到创造者的第二封信')
    assert.ok(
      typeof secondLetter.content === 'string' && secondLetter.content.includes('12:00:00'),
      `创造者应报告时间，实际: ${JSON.stringify(secondLetter.content)}`,
    )

    // 验证：子 agent 存在，parentId 为创造者；回信作为 tool 结果填充（非信件）
    const creator = await kernel.instances.get(creatorId)
    const agents = await kernel.instances.listBySpace(creator.spaceId)
    const sub = agents.find((a) => a.parentId === creatorId)
    assert.ok(sub, '应存在由创造者创建的子 agent')
    assert.equal(sub.parentId, creatorId)

    const state = await kernel.contextManager.getState(creatorId)
    // context_wait 的 tool 结果应包含子 agent 的回信文本
    const waitResult = state.messages.find(
      (m) => m.message.role === 'tool' && typeof m.message.content === 'string' && m.message.content.includes('12:00:00'),
    )
    assert.ok(waitResult, '子 agent 回信应作为 context_wait 的 tool 结果进入创造者上下文')
  })
})
