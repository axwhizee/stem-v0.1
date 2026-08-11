// ============================================================
// test-support/kernelHarness.ts —— kernel 集成测试辅助
//
// 提供：手动倒计时（同步触发）、用户收信等待队列、标准 kernel 构造。
// ============================================================

import { AgentKernel, makeAgentClassID, USER_ID } from '../src/core/kernel'
import type { UserDelivery } from '../src/core/context'
import { DefaultToolCapabilityRegistry } from '../src/core/tools'
import type { FakeGateway } from '../src/core/gateway'

export function manualTimers() {
  const pending = new Set<() => void>()
  return {
    timer: (fn: () => void) => {
      pending.add(fn)
      return { cancel: () => void pending.delete(fn) }
    },
    /** 触发所有挂起倒计时（同步）。 */
    flushAll: () => {
      const fns = [...pending]
      pending.clear()
      for (const fn of fns) fn()
    },
    count: () => pending.size,
  }
}

export function userDeliveryQueue() {
  const queue: UserDelivery[] = []
  const waiters: Array<{ resolve: (d: UserDelivery) => void }> = []
  return {
    push: (d: UserDelivery) => {
      const waiter = waiters.shift()
      if (waiter) waiter.resolve(d)
      else queue.push(d)
    },
    next: () =>
      new Promise<UserDelivery>((resolve) => {
        const q = queue.shift()
        if (q) resolve(q)
        else waiters.push({ resolve })
      }),
  }
}

export interface Harness {
  kernel: AgentKernel
  timers: ReturnType<typeof manualTimers>
  deliveries: ReturnType<typeof userDeliveryQueue>
  tools: DefaultToolCapabilityRegistry
}

export async function createKernelHarness(
  gateway: FakeGateway,
  opts: {
    countdownMs?: number
    templates?: ConstructorParameters<typeof AgentKernel>[0]['templates']
    onEvent?: (agentId: string, event: never) => void
  } = {},
): Promise<Harness> {
  const timers = manualTimers()
  const deliveries = userDeliveryQueue()
  const tools = new DefaultToolCapabilityRegistry()

  const kernel = new AgentKernel({
    gateway,
    defaultModel: { provider: 'opencode', id: 'test-model' },
    tools,
    templates: opts.templates,
    defaultCountdownMs: opts.countdownMs ?? 1000,
    timer: timers.timer,
    onUserDelivery: (d) => deliveries.push(d),
  })
  await kernel.registerUser()
  return { kernel, timers, deliveries, tools }
}

export function simpleChatId() {
  return makeAgentClassID('simple-chat')
}

export { USER_ID }
