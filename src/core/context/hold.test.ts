// ============================================================
// core/context/hold.test.ts —— instantiate.wait 挂起配对竞态单测
//
// holds Map = 独占消费表（deposit 命中 → tool 填充并删除）；
// Waiter hold: 键 = 仅超时自回填。两者分工，本卷锁定配对语义。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DefaultRepository } from './Repository'
import { DefaultCourier } from './Courier'
import { DefaultContextManager } from './ContextManager'
import type { TimerFactory } from './wait'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function manualTimers() {
  const pending = new Set<() => void>()
  const timer: TimerFactory = (fn, ms) => {
    if (ms <= 0) {
      const h = setTimeout(fn, 0)
      return { cancel: () => clearTimeout(h) }
    }
    pending.add(fn)
    return { cancel: () => void pending.delete(fn) }
  }
  return {
    timer,
    flushAll: () => {
      const fns = [...pending]
      pending.clear()
      for (const fn of fns) fn()
    },
  }
}

function makeCm(timer?: TimerFactory) {
  const repository = new DefaultRepository()
  const courier = new DefaultCourier({ repository, defaultCountdownMs: 0, ...(timer !== undefined ? { timer } : {}) })
  const cm = new DefaultContextManager({
    repository,
    courier,
    ...(timer !== undefined ? { timer } : {}),
  })
  repository.onChange = (agentId) => cm.handleChange(agentId)
  return { repository, cm }
}

async function registerPair(cm: DefaultContextManager) {
  await cm.register({ agentId: 'parent', systemPrompt: 'p-sys', onDelivery: () => {} })
  await cm.register({ agentId: 'child', systemPrompt: 'c-sys', onDelivery: () => {} })
}

function toolRows(cm: DefaultContextManager, agentId: string) {
  return cm.repository.listValid(agentId).filter((m) => m.message.role === 'tool')
}

describe('hold 配对：deposit 独占消费', () => {
  test('registerHold 后子回信 → tool 填充，不进父信箱', async () => {
    const { cm } = makeCm()
    await registerPair(cm)
    await cm.registerHold('child', { ownerId: 'parent', toolCallId: 'tc-1' })
    await cm.deposit('parent', { role: 'assistant', content: 'done' }, 'child')

    const rows = toolRows(cm, 'parent')
    assert.equal(rows.length, 1)
    assert.equal(String(rows[0]!.message.content), 'done')
    assert.equal((rows[0]!.message as { toolCallId?: string }).toolCallId, 'tc-1')
    // 父信箱不应再有这封 assistant 信（hold 吃掉）。
    const letters = cm.repository.listValid('parent').filter((m) => m.message.role === 'assistant')
    assert.equal(letters.length, 0)
  })

  test('二次 deposit 同 from → hold 已消费，走普通信箱', async () => {
    const { cm } = makeCm()
    await registerPair(cm)
    await cm.registerHold('child', { ownerId: 'parent', toolCallId: 'tc-1' })
    await cm.deposit('parent', { role: 'assistant', content: 'first' }, 'child')
    await cm.deposit('parent', { role: 'assistant', content: 'second' }, 'child')

    const tools = toolRows(cm, 'parent')
    assert.equal(tools.length, 1)
    const letters = cm.repository.listValid('parent').filter((m) => m.message.role === 'assistant')
    assert.equal(letters.length, 1)
    assert.equal(String(letters[0]!.message.content), 'second')
  })

  test('无 hold 的 deposit → 普通信箱', async () => {
    const { cm } = makeCm()
    await registerPair(cm)
    await cm.deposit('parent', { role: 'assistant', content: 'hello' }, 'child')

    assert.equal(toolRows(cm, 'parent').length, 0)
    const letters = cm.repository.listValid('parent').filter((m) => m.message.role === 'assistant')
    assert.equal(letters.length, 1)
  })

  test('hold 键是 from（子 id），他人来信不命中', async () => {
    const { cm } = makeCm()
    await registerPair(cm)
    await cm.register({ agentId: 'other', systemPrompt: 'o', onDelivery: () => {} })
    await cm.registerHold('child', { ownerId: 'parent', toolCallId: 'tc-1' })
    await cm.deposit('parent', { role: 'assistant', content: 'from-other' }, 'other')

    assert.equal(toolRows(cm, 'parent').length, 0)
    const letters = cm.repository.listValid('parent').filter((m) => m.message.role === 'assistant')
    assert.equal(letters.length, 1)
    // hold 仍在，真子回信仍可命中。
    await cm.deposit('parent', { role: 'assistant', content: 'from-child' }, 'child')
    const tools = toolRows(cm, 'parent')
    assert.equal(tools.length, 1)
    assert.equal(String(tools[0]!.message.content), 'from-child')
  })
})

describe('hold 配对：超时 / 取消 / 注销', () => {
  test('timeout 到点自回填；其后 deposit 走普通信箱', async () => {
    const timers = manualTimers()
    const { cm } = makeCm(timers.timer)
    await registerPair(cm)
    await cm.registerHold('child', { ownerId: 'parent', toolCallId: 'tc-t', timeoutMs: 50 })
    await tick()
    timers.flushAll()
    await tick()

    const tools = toolRows(cm, 'parent')
    assert.equal(tools.length, 1)
    assert.match(String(tools[0]!.message.content), /超时/)

    await cm.deposit('parent', { role: 'assistant', content: 'late' }, 'child')
    assert.equal(toolRows(cm, 'parent').length, 1, '超时后 hold 已删，迟到信走信箱')
    const letters = cm.repository.listValid('parent').filter((m) => m.message.role === 'assistant')
    assert.equal(letters.length, 1)
    assert.equal(String(letters[0]!.message.content), 'late')
  })

  test('deposit 先于超时 → 消费 hold，超时不重复回填', async () => {
    const timers = manualTimers()
    const { cm } = makeCm(timers.timer)
    await registerPair(cm)
    await cm.registerHold('child', { ownerId: 'parent', toolCallId: 'tc-t', timeoutMs: 50 })
    await cm.deposit('parent', { role: 'assistant', content: 'in-time' }, 'child')
    await tick()
    timers.flushAll()
    await tick()

    const tools = toolRows(cm, 'parent')
    assert.equal(tools.length, 1)
    assert.equal(String(tools[0]!.message.content), 'in-time')
  })

  test('cancelHold 幂等：撤销后 deposit 走信箱；再撤无害', async () => {
    const { cm } = makeCm()
    await registerPair(cm)
    await cm.registerHold('child', { ownerId: 'parent', toolCallId: 'tc-1' })
    await cm.cancelHold('parent', 'child')
    await cm.cancelHold('parent', 'child')
    await cm.deposit('parent', { role: 'assistant', content: 'after-cancel' }, 'child')

    assert.equal(toolRows(cm, 'parent').length, 0)
    const letters = cm.repository.listValid('parent').filter((m) => m.message.role === 'assistant')
    assert.equal(letters.length, 1)
  })

  test('他人 cancelHold 不得撤销（owner 门禁）', async () => {
    const { cm } = makeCm()
    await registerPair(cm)
    await cm.register({ agentId: 'other', systemPrompt: 'o', onDelivery: () => {} })
    await cm.registerHold('child', { ownerId: 'parent', toolCallId: 'tc-1' })
    await cm.cancelHold('other', 'child')
    await cm.deposit('parent', { role: 'assistant', content: 'still-held' }, 'child')

    const tools = toolRows(cm, 'parent')
    assert.equal(tools.length, 1)
    assert.equal(String(tools[0]!.message.content), 'still-held')
  })

  test('owner 注销清理 holds；其后子回信进子侧普通路径', async () => {
    const { cm } = makeCm()
    await registerPair(cm)
    await cm.registerHold('child', { ownerId: 'parent', toolCallId: 'tc-1' })
    await cm.unregister('parent')
    // parent 箱已卸；deposit 到 parent 应因 require 失败——改测 holds 已清：
    // 重新挂 parent 后，旧 hold 不应复活。
    await cm.register({ agentId: 'parent', systemPrompt: 'p2', onDelivery: () => {} })
    await cm.deposit('parent', { role: 'assistant', content: 'orphan' }, 'child')

    assert.equal(toolRows(cm, 'parent').length, 0)
    const letters = cm.repository.listValid('parent').filter((m) => m.message.role === 'assistant')
    assert.equal(letters.length, 1, '注销清 holds 后回信不得再命中旧配对')
  })

  test('registerHold 覆盖同 waitFor 旧登记（后写生效）', async () => {
    const { cm } = makeCm()
    await registerPair(cm)
    await cm.register({ agentId: 'parent2', systemPrompt: 'p2', onDelivery: () => {} })
    await cm.registerHold('child', { ownerId: 'parent', toolCallId: 'tc-old' })
    await cm.registerHold('child', { ownerId: 'parent2', toolCallId: 'tc-new' })
    await cm.deposit('parent2', { role: 'assistant', content: 'to-new' }, 'child')

    assert.equal(toolRows(cm, 'parent2').length, 1)
    assert.equal(toolRows(cm, 'parent').length, 0)
  })
})
