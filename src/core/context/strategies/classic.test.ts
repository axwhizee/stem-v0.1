// ============================================================
// core/context/strategies/classic.test.ts —— compact 纯逻辑（假 API 驱动）
//
// 验证 classic 压缩核心：轮边界切割（keepRecentTurns）、旧段 markInvalid、
// 摘要经 append(tag='summary') 正规追加、worker 产出为空/失败时安全跳过。
// 不经邮局/kernel（无计时器，确定性强）。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createClassicStrategy, classicAssemble } from './classic'
import type { ContextStrategyModule, ContextSettings, StrategyApi } from './types'
import type { StoredMessage } from '../types'
import type { ChatMessage } from '../../gateway'

function stored(id: string, turn: number, role: ChatMessage['role'], content: string): StoredMessage {
  return { id, agentId: 'a1', message: { role, content }, at: 0, tokens: Math.ceil(content.length / 4), valid: true, turn, indexInTurn: 0 }
}

/** 可变消息盒（StoredMessage 为只读形状，测试内部以新对象替换）。 */
interface FakeBox {
  readonly api: StrategyApi
  readonly appended: Array<{ msg: ChatMessage; tag?: string }>
  readonly invalidated: string[][]
  messages: StoredMessage[]
}

function makeApi(messages: StoredMessage[], overrides: Partial<StrategyApi> = {}): FakeBox {
  const appended: Array<{ msg: ChatMessage; tag?: string }> = []
  const invalidated: string[][] = []
  const settings: ContextSettings = {
    window: 1000,
    compact: { enabled: true, threshold: 0.01, keepRecentTurns: 1, replyTimeoutMs: 60_000 },
  }
  const box: FakeBox = {
    appended,
    invalidated,
    messages,
    api: {
      agentId: 'a1',
      settings,
      estimatedTokens: () => box.messages.filter((m) => m.valid).reduce((s, m) => s + m.tokens, 0),
      list: () => box.messages,
      listValid: () => box.messages.filter((m) => m.valid),
      append: async (msg, tag) => {
        appended.push({ msg, tag })
      },
      markInvalid: async (ids) => {
        invalidated.push([...ids])
        const set = new Set(ids)
        box.messages = box.messages.map((m) => (set.has(m.id) ? { ...m, valid: false } : m))
      },
      spawn: async () => 'WORKER_SUMMARY',
      log: () => {},
      ...overrides,
    },
  }
  return box
}

function compactOf(strategy: ContextStrategyModule): (api: StrategyApi, args: string) => Promise<string> {
  const fn = strategy.actions?.['compact']
  assert.ok(fn !== undefined, 'classic 必须导出 compact 动作')
  return fn
}

describe('classicAssemble', () => {
  test('system 抽出 + 其余原样直出', () => {
    const result = classicAssemble({
      agentId: 'a1',
      messages: [stored('m-1', 0, 'system', 'SYS'), stored('m-2', 1, 'user', 'hi'), stored('m-3', 1, 'assistant', 'yo')],
    })
    assert.equal(result.system, 'SYS')
    assert.deepEqual(result.messages.map((m) => m.content), ['hi', 'yo'])
    assert.deepEqual(result.messageIds, ['m-1', 'm-2', 'm-3'])
  })
})

describe('classic compact（策略专有动作）', () => {
  const strategy = createClassicStrategy()
  const compact = compactOf(strategy)

  test('轮边界切割：keepRecentTurns=1 → 只压 turn<=maxTurn-1 的旧段', async () => {
    const box = makeApi([
      stored('m-1', 0, 'system', 'SYS'),
      stored('m-2', 1, 'user', 'first question here'),
      stored('m-3', 1, 'assistant', 'first answer here'),
      stored('m-4', 2, 'user', 'second question!'),
      stored('m-5', 2, 'assistant', 'second answer..'),
      stored('m-6', 3, 'user', 'third question'),
    ])
    const text = await compact(box.api, '')
    assert.match(text, /已压缩/)
    // turn<=2 的消息被压（m-2..m-5），m-6（当前轮）保留；system 保留。
    assert.equal(box.messages.find((m) => m.id === 'm-6')!.valid, true)
    assert.equal(box.messages.find((m) => m.id === 'm-1')!.valid, true)
    assert.equal(box.messages.find((m) => m.id === 'm-2')!.valid, false)
    assert.equal(box.messages.find((m) => m.id === 'm-5')!.valid, false)
    // 摘要经 append 正规追加（tag=summary，role=user，带轮区间标记）。
    assert.equal(box.appended.length, 1)
    assert.equal(box.appended[0]!.tag, 'summary')
    assert.match(String(box.appended[0]!.msg.content), /<context_summary turns="1-2">/)
    assert.match(String(box.appended[0]!.msg.content), /WORKER_SUMMARY/)
  })

  test('轮数不足（未超 keepRecentTurns）→ 跳过，不动上下文', async () => {
    const box = makeApi([
      stored('m-1', 0, 'system', 'SYS'),
      stored('m-2', 1, 'user', 'only one'),
      stored('m-3', 1, 'assistant', 'reply'),
    ])
    const text = await compact(box.api, '')
    assert.match(text, /轮数不足/)
    assert.equal(box.appended.length, 0)
    assert.equal(box.invalidated.length, 0)
    assert.ok(box.messages.every((m) => m.valid))
  })

  test('worker 产出空 → 安全跳过（不 markInvalid）', async () => {
    const box = makeApi(
      [stored('m-1', 0, 'system', 'SYS'), stored('m-2', 1, 'user', 'aaa'), stored('m-3', 2, 'user', 'bbb'), stored('m-4', 3, 'user', 'ccc')],
      { spawn: async () => '   ' },
    )
    const text = await compact(box.api, '')
    assert.match(text, /摘要为空/)
    assert.equal(box.invalidated.length, 0)
    assert.ok(box.messages.every((m) => m.valid), '摘要空时旧消息保持有效')
  })

  test('worker 抛错 → 失败兜底（返回失败串，不抛出，不破坏上下文）', async () => {
    const box = makeApi(
      [stored('m-1', 0, 'system', 'SYS'), stored('m-2', 1, 'user', 'aaa'), stored('m-3', 2, 'user', 'bbb'), stored('m-4', 3, 'user', 'ccc')],
      {
        spawn: async () => {
          throw { kind: 'context_reply_timeout' }
        },
      },
    )
    const text = await compact(box.api, '')
    assert.match(text, /压缩失败/)
    assert.ok(box.messages.every((m) => m.valid))
  })

  test('process：低于阈值不动作，超阈值触发压缩', async () => {
    const low = makeApi([stored('m-1', 0, 'system', 'S'), stored('m-2', 1, 'user', 'short'), stored('m-3', 1, 'assistant', 'ok')])
    await strategy.process!(low.api)
    assert.equal(low.appended.length, 0, '低于 budget 不压缩')

    const big = makeApi([
      stored('m-1', 0, 'system', 'S'),
      ...Array.from({ length: 6 }, (_, i) => stored(`u-${String(i)}`, i + 1, 'user', 'x'.repeat(400))),
    ])
    await strategy.process!(big.api)
    assert.equal(big.appended.length, 1, '超 budget 自动压缩')
  })
})
