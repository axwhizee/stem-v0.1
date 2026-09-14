// ============================================================
// core/context/wait.test.ts —— 统一挂起原语单测
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DefaultWaiter, waitKeys } from './wait'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('Waiter：事件 / 超时 / 中断 / cancelOwner', () => {
  test('emit 兑现 event payload；无等待者返回 false', async () => {
    const waiter = new DefaultWaiter()
    const p = waiter.wait<string>({ key: waitKeys.reply('w1'), owner: 'role' })
    await tick()
    assert.equal(waiter.emit(waitKeys.reply('w1'), 'hello'), true)
    const r = await p
    assert.deepEqual(r, { kind: 'event', payload: 'hello' })
    assert.equal(waiter.emit(waitKeys.reply('w1'), 'x'), false)
  })

  test('timeout 到点兑现 timeout', async () => {
    const waiter = new DefaultWaiter((fn, ms) => {
      const h = setTimeout(fn, ms)
      return { cancel: () => clearTimeout(h) }
    })
    const r = await waiter.wait({ key: waitKeys.timer('t1'), owner: 'a', timeoutMs: 1 })
    assert.equal(r.kind, 'timeout')
  })

  test('signal aborted → aborted；cancelOwner 注销全部', async () => {
    const waiter = new DefaultWaiter()
    const ctl = new AbortController()
    const p1 = waiter.wait({ key: 'k1', owner: 'a', signal: ctl.signal })
    const p2 = waiter.wait({ key: 'k2', owner: 'a' })
    await tick()
    ctl.abort()
    assert.equal((await p1).kind, 'aborted')
    waiter.cancelOwner('a')
    assert.equal((await p2).kind, 'aborted')
  })

  test('cancel(key, owner) 只杀指定等待者', async () => {
    const waiter = new DefaultWaiter()
    const a = waiter.wait({ key: 'k', owner: 'a' })
    const b = waiter.wait({ key: 'k', owner: 'b' })
    await tick()
    waiter.cancel('k', 'a')
    assert.equal((await a).kind, 'aborted')
    waiter.emit('k', 'go')
    const rb = await b
    assert.deepEqual(rb, { kind: 'event', payload: 'go' })
  })

  test('同键多等待者一次 emit 全兑现', async () => {
    const waiter = new DefaultWaiter()
    const a = waiter.wait<string>({ key: 'k', owner: 'a' })
    const b = waiter.wait<string>({ key: 'k', owner: 'b' })
    await tick()
    waiter.emit('k', 1)
    const ra = await a
    const rb = await b
    assert.equal(ra.kind, 'event')
    assert.equal(rb.kind, 'event')
    if (ra.kind === 'event') assert.equal(ra.payload, 1)
    if (rb.kind === 'event') assert.equal(rb.payload, 1)
  })
})
