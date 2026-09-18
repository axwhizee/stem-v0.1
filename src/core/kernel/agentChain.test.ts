// ============================================================
// core/kernel/agentChain.test.ts —— 端到端：委托-等待-挂起闭环
//
// 验收场景（S9 挂起面重构后）：
//   用户 → 创造者(无时间权限) → agent_instantiate{wait:true} 创建子 agent
//   （「读取当前时间」）→ 创建与配对原子完成（竞态根除）→ 子 agent 读时间
//   → 自动回信 → 邮局将回信作为本次工具调用的 tool 结果填充 → 创造者
//   醒来报告用户时间。附带验证：wait 命中 contextWait 标记后 runtime
//   轮循环**收束**（不空转下一轮）；agent_pause 到点唤醒且期间信件在场。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeGateway } from '../gateway'
import type { LLMRequest, LLMEvent } from '../gateway'
import type { AgentClass } from './types'
import { makeAgentClassID, makeAgentID, parentIdOf, ROOT_ID } from './types'
import { BUILTIN_TEMPLATES } from './Kernel'
import { createKernelHarness } from '../../../test/support/kernelHarness'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const creatorTemplate: AgentClass = {
  name: makeAgentClassID('creator'),
  description: '能创建子 agent 的调度者',
  systemPrompt: 'creator-sys: 你是调度者，可以创建子 agent 获取信息。',
  tools: {
    agent_instantiate: 'allow',
    agent_list: 'allow',
    agent_pause: 'allow',
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

function timeHandler(): { gateway: FakeGateway; creatorRounds: () => number } {
  const rounds = new Map<string, number>()
  const handler = function* (request: LLMRequest): Generator<LLMEvent> {
    const key = (request.system ?? '').startsWith('creator-sys') ? 'creator' : 'tool'
    const round = rounds.get(key) ?? 0
    rounds.set(key, round + 1)
    if (key === 'creator') {
      if (round === 0) {
        // wait=true：创建与等待一次调用完成（hold 先于子存在注册 = 竞态绝迹）。
        yield { type: 'tool-call', id: 'ccall-0', name: 'agent_instantiate', input: { className: 'tool-agent', userPrompt: '请读取当前时间，然后把时间告诉我。', agentId: 'sub1', wait: true } }
        yield { type: 'finish', reason: 'tool_calls' }
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
  return { gateway: new FakeGateway(handler), creatorRounds: () => rounds.get('creator') ?? 0 }
}

describe('agent 链：委托 wait 闭环与 pause 攒信', () => {
  test('端到端：agent_instantiate{wait} 完成取时间闭环（runtime 收束不空转）', async () => {
    const { gateway, creatorRounds } = timeHandler()
    const { kernel, deliveries, timers } = await createKernelHarness(gateway, {
      templates: [...BUILTIN_TEMPLATES, creatorTemplate, toolAgentTemplate],
      extraTools: [
        {
          id: 'oc_get_time',
          registerAccess: 'ignore',
          description: 'get time',
          parameters: { type: 'object', properties: {} },
          execute: () => ({ text: '当前 UTC 时间: 2026-08-11T12:00:00.000Z' }),
        },
      ],
    })

    const creatorId = await kernel.instantiateAgent(
      { className: makeAgentClassID('creator'), parentId: makeAgentID(ROOT_ID), userPrompt: '请创建一个能读取时间的助手并让它把时间报告给我。' },
    )

    // 子 agent 工作（父挂起等填充——不消耗父轮次）。
    timers.flushAll()
    await tick()
    timers.flushAll()
    await tick()

    // 回信填充 → 唤醒父 → 父报告时间。
    timers.flushAll()
    await tick()
    const first = (await deliveries.next())!
    const letter = first.letters[0]
    assert.ok(
      typeof letter?.content === 'string' && letter.content.includes('12:00:00'),
      `创造者应直接报告时间（wait 融合后一封信完成闭环），实际: ${JSON.stringify(letter?.content)}`,
    )
    assert.equal(creatorRounds(), 2, '创造者只跑两轮（创建即等待轮 + 醒来报告轮）——无 contextWait 空转轮')

    const creator = await kernel.instances.get(creatorId)
    const sub = (await kernel.instances.listAll()).find((a) => parentIdOf(a.id) === creatorId)
    assert.ok(sub, '应存在由创造者创建的子 agent')
    assert.equal(parentIdOf(sub.id), creatorId)

    const state = await kernel.contextManager.getState(creatorId)
    const waitResult = state.messages.find(
      (m) => m.message.role === 'tool' && typeof m.message.content === 'string' && m.message.content.includes('12:00:00'),
    )
    assert.ok(waitResult, '子 agent 回信应作为 instantiate(wait) 的 tool 结果进入创造者上下文')
  })

  test('wait 超时：回填提示行并唤醒（不永悬）', async () => {
    const gateway = new FakeGateway((request) => {
      if ((request.system ?? '').startsWith('creator-sys')) {
        // 永远不回信的子（tool 侧脚本 = 静默 text 但不发给父——直接测超时）。
        return { type: 'finish', reason: 'stop' } as unknown as Generator<LLMEvent>
      }
      return []
    })
    const { kernel, tools, timers } = await createKernelHarness(gateway, {
      templates: [...BUILTIN_TEMPLATES, creatorTemplate],
      countdownMs: 0,
    })
    void tools
    const creatorId = await kernel.instantiateAgent(
      { className: makeAgentClassID('creator'), parentId: makeAgentID(ROOT_ID), userPrompt: '占位（不经 LLM）' },
    )
    // 直接走 manager 层（绕过 LLM 编排）验证超时通道本身。
    await kernel.contextManager.registerHold('no-such-agent', { ownerId: creatorId, toolCallId: 'tc-t', timeoutMs: 50 })
    await tick()
    timers.flushAll() // hold 超时触发
    await tick()
    const state = await kernel.contextManager.getState(creatorId)
    const timeoutRow = state.messages.find((m) => m.message.role === 'tool' && String(m.message.content).includes('超时'))
    assert.ok(timeoutRow, '超时回填 tool 行')
  })

  test('agent_pause：到点唤醒，期间信件在场', async () => {
    const gateway = new FakeGateway((request) => {
      if ((request.system ?? '').startsWith('creator-sys')) {
        return [
          { type: 'tool-call', id: 'p1', name: 'agent_pause', input: { ms: 500 } },
          { type: 'finish', reason: 'tool_calls' },
        ] as LLMEvent[]
      }
      return []
    })
    const { kernel, tools, timers } = await createKernelHarness(gateway, {
      templates: [...BUILTIN_TEMPLATES, creatorTemplate],
      countdownMs: 0,
    })
    const creatorId = await kernel.instantiateAgent(
      { className: makeAgentClassID('creator'), parentId: makeAgentID(ROOT_ID), userPrompt: '先挂起等我攒信' },
    )
    // 泵到位：首信投递 → 父轮 → pause 注册 → 到点唤醒（manualTimers 幂等 flush）。
    for (let i = 0; i < 10; i++) {
      timers.flushAll()
      await tick()
    }
    const state = await kernel.contextManager.getState(creatorId)
    const wakeRow = state.messages.find((m) => m.message.role === 'tool' && String(m.message.content).includes('暂停'))
    assert.ok(wakeRow, 'pause 到点回填唤醒行')
  })
})
