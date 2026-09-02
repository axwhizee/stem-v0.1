import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { forget } from './forget'
import type { LogEvent } from './events'

describe('forget：孤儿 promise 安全阀（P6 教训原语）', () => {
  const capture = () => {
    const events: LogEvent[] = []
    return { events, sink: (e: LogEvent) => { events.push(e) } }
  }

  test('not_found/terminated 竞态族 = 静默丢弃', async () => {
    const { events, sink } = capture()
    forget(Promise.reject({ kind: 'agent_not_found', agentId: 'x' }), 't', sink)
    forget(Promise.reject({ kind: 'mailbox_not_found', agentId: 'y' }), 't', sink)
    forget(Promise.reject({ kind: 'agent_terminated', agentId: 'z' }), 't', sink)
    await new Promise((r) => setTimeout(r, 5))
    assert.deepEqual(events, [])
  })

  test('非竞态缺陷 = kernel.orphan.error 针点（存活不崩）', async () => {
    const { events, sink } = capture()
    forget(Promise.reject({ kind: 'gateway_unauthorized', message: 'boom' }), 'test:site', sink)
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(events.length, 1)
    assert.equal(events[0]?.type, 'kernel.orphan.error')
    assert.match(JSON.stringify(events[0]), /gateway_unauthorized/)
  })

  test('LogSink 对象口与函数口双形态适配；Error 实例兜底 String', async () => {
    const events: LogEvent[] = []
    forget(Promise.reject(new Error('plain')), 't', { log: (e) => events.push(e) })
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(events.length, 1)
    assert.match(JSON.stringify(events[0]), /plain/)
  })

  test('fulfilled promise 零副作用', async () => {
    const { events, sink } = capture()
    forget(Promise.resolve('ok'), 't', sink)
    await new Promise((r) => setTimeout(r, 5))
    assert.deepEqual(events, [])
  })
})
