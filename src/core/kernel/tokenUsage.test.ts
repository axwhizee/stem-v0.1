// ============================================================
// core/kernel/tokenUsage.test.ts —— 真实 token 计量归位（T3 累积差分法）
//
// 验证链路：gateway usage 事件 → assistant 行 append 直记 output +
// ContextManager.attributeUsage 差分归位（tool/user 行按估算占比分摊，
// 负差护栏回落，末行吸收凑整）。FakeGateway 注真实形状 usage，零 mock 全局。
// ============================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeGateway } from '../gateway'
import type { LLMRequest, LLMEvent } from '../gateway'
import { makeAgentClassID, makeAgentID, ROOT_ID } from './types'
import { BUILTIN_TEMPLATES } from './Kernel'
import { createKernelHarness } from '../../../test/support/kernelHarness'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** 固定长度回声工具（结果长度可控 → 估算占比可预期）。 */
async function registerEcho(tools: Awaited<ReturnType<typeof createKernelHarness>>['tools'], pad: number) {
  await tools.register({
    id: 'echo_pad',
    birth: 'ignore',
    description: '回声',
    parameters: {
      type: 'object',
      properties: { n: { type: 'number', description: '调用序号（区分两次结果）' } },
    },
    execute: (input) => {
      const { n } = (input ?? {}) as { n?: number }
      return { text: `${n ?? 0}:${'x'.repeat(pad)}` }
    },
  })
}

async function spawnWorker(h: Awaited<ReturnType<typeof createKernelHarness>>, prompt: string) {
  const id = await h.kernel.instantiateAgent(
    {
      className: makeAgentClassID('coder'),
      parentId: makeAgentID(ROOT_ID),
      userPrompt: prompt,
    },
    '/proj',
  )
  // coder 类 tools 表放行 echo_pad。
  await h.deliveries.next(0) // user#0 收信（或超时 null）
  h.timers.flushAll()
  await tick()
  h.timers.flushAll()
  await tick()
  return id
}

test('单轮工具环：assistant=output 直记，tool 行=input 差分归位', async () => {
  const handler = function* (_request: LLMRequest): Generator<LLMEvent> {
    // 按 session 尾部判断轮次：最后一条是 tool → 第二轮。
    const last = _request.messages[_request.messages.length - 1]
    if (last?.role === 'tool') {
      yield { type: 'text-delta', text: '完成。' }
      yield { type: 'usage', inputTokens: 1200, outputTokens: 30 }
      yield { type: 'finish', reason: 'stop' }
    } else {
      yield { type: 'tool-call', id: 'c1', name: 'echo_pad', input: { n: 1 } }
      yield { type: 'usage', inputTokens: 1000, outputTokens: 50 }
      yield { type: 'finish', reason: 'tool_calls' }
    }
  }
  const h = await createKernelHarness(new FakeGateway(handler), {
    templates: [
      ...BUILTIN_TEMPLATES,
      {
        name: makeAgentClassID('coder'),
        description: '工具工',
        systemPrompt: 'sys',
        tools: { echo_pad: 'allow' },
      },
    ],
  })
  await registerEcho(h.tools, 100)
  const id = await spawnWorker(h, '干活')

  const state = await h.kernel.contextManager.getState(id)
  const assistant = state.messages.filter((m) => m.message.role === 'assistant')
  const tool = state.messages.find((m) => m.message.role === 'tool')
  assert.equal(assistant[0]?.tokens, 50, 'assistant 首轮 = output 真实值')
  assert.equal(assistant[1]?.tokens, 30, 'assistant 次轮 = output 真实值')
  assert.equal(tool?.tokens, 1200 - 1000 - 50, 'tool 行 = input 差分（150）覆盖估算')
  const user = state.messages.find((m) => m.message.role === 'user')
  assert.ok(user && user.tokens > 0 && user.tokens < 150, '首轮基线：user 行保持小估算不动')
})

test('两条 tool 行：差分按估算占比分摊，和 = 真实增量', async () => {
  const handler = function* (request: LLMRequest): Generator<LLMEvent> {
    const toolCount = request.messages.filter((m) => m.role === 'tool').length
    if (toolCount >= 2) {
      yield { type: 'text-delta', text: 'done' }
      yield { type: 'usage', inputTokens: 1600, outputTokens: 20 }
      yield { type: 'finish', reason: 'stop' }
    } else {
      yield { type: 'tool-call', id: 'c1', name: 'echo_pad', input: { n: 1 } }
      yield { type: 'tool-call', id: 'c2', name: 'echo_pad', input: { n: 2 } }
      yield { type: 'usage', inputTokens: 1000, outputTokens: 40 }
      yield { type: 'finish', reason: 'tool_calls' }
    }
  }
  const h = await createKernelHarness(new FakeGateway(handler), {
    templates: [
      ...BUILTIN_TEMPLATES,
      { name: makeAgentClassID('coder'), description: 'x', systemPrompt: 'sys', tools: { echo_pad: 'allow' } },
    ],
  })
  await registerEcho(h.tools, 100)
  const id = await spawnWorker(h, '干活')

  const state = await h.kernel.contextManager.getState(id)
  const tools = state.messages.filter((m) => m.message.role === 'tool')
  assert.equal(tools.length, 2)
  const sum = (tools[0]?.tokens ?? 0) + (tools[1]?.tokens ?? 0)
  assert.equal(sum, 1600 - 1000 - 40, '两行合计 = 差分增量（560）')
  assert.ok((tools[0]?.tokens ?? 0) >= 1 && (tools[1]?.tokens ?? 0) >= 1, '均为正数分摊')
})

test('负差分护栏：compact 型跳变回落估算，assistant 直记不受影响', async () => {
  const handler = function* (request: LLMRequest): Generator<LLMEvent> {
    const last = request.messages[request.messages.length - 1]
    if (last?.role === 'tool') {
      yield { type: 'text-delta', text: 'ok' }
      yield { type: 'usage', inputTokens: 300, outputTokens: 20 } // 假跳变（低于基线）
      yield { type: 'finish', reason: 'stop' }
    } else {
      yield { type: 'tool-call', id: 'c1', name: 'echo_pad', input: { n: 1 } }
      yield { type: 'usage', inputTokens: 1000, outputTokens: 50 }
      yield { type: 'finish', reason: 'tool_calls' }
    }
  }
  const h = await createKernelHarness(new FakeGateway(handler), {
    templates: [
      ...BUILTIN_TEMPLATES,
      { name: makeAgentClassID('coder'), description: 'x', systemPrompt: 'sys', tools: { echo_pad: 'allow' } },
    ],
  })
  await registerEcho(h.tools, 100)
  const id = await spawnWorker(h, '干活')

  const state = await h.kernel.contextManager.getState(id)
  const tool = state.messages.find((m) => m.message.role === 'tool')
  const assistant = state.messages.filter((m) => m.message.role === 'assistant')
  assert.ok(tool && tool.tokens > 0 && tool.tokens < 150, 'tool 行保持估算回落（未摊上负差）')
  assert.equal(assistant[0]?.tokens, 50)
  assert.equal(assistant[1]?.tokens, 20, '负差轮 assistant 仍直记 output')
})

// totalCost 经 mergeUsage→estimateCost 累计为 S6 既有通道（harness 缺省无定价表
// 返回 0），真实口径的端到端抽查归入 T4 实网验证，不在此重复断言。
