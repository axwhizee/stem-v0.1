// ============================================================
// test-support/kernelHarness.ts —— kernel 集成测试辅助
//
// 提供：手动倒计时（同步触发）、用户收信等待队列、标准 kernel 构造。
// ============================================================

import { Kernel, makeAgentClassID, USER_ID } from '../src/core/kernel'
import type { UserDelivery } from '../src/core/context'
import type { ContextSettings, StrategyRegistry } from '../src/core/context'
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
  const waiters: Array<{ resolve: (d: UserDelivery) => void; id: number }> = []
  let nextId = 0
  return {
    push: (d: UserDelivery) => {
      const waiter = waiters.shift()
      if (waiter) waiter.resolve(d)
      else queue.push(d)
    },
    /** 等待下一封；timeoutMs 后 resolve(null)（自动从等待队列移除，避免僵尸 waiter）。 */
    next: (timeoutMs?: number) =>
      new Promise<UserDelivery | null>((resolve) => {
        const buffered = queue.shift()
        if (buffered) {
          resolve(buffered)
          return
        }
        const waiter = { resolve, id: ++nextId }
        waiters.push(waiter)
        if (timeoutMs !== undefined) {
          setTimeout(() => {
            const index = waiters.findIndex((w) => w.id === waiter.id)
            if (index >= 0) {
              waiters.splice(index, 1)
              resolve(null)
            }
          }, timeoutMs)
        }
      }),
  }
}

export interface Harness {
  kernel: Kernel
  timers: ReturnType<typeof manualTimers>
  deliveries: ReturnType<typeof userDeliveryQueue>
  tools: DefaultToolCapabilityRegistry
}

export async function createKernelHarness(
  gateway: FakeGateway,
  opts: {
    countdownMs?: number
    templates?: ConstructorParameters<typeof Kernel>[0]['templates']
    /** user0 内嵌类配置（族谱权限收敛起点；缺省 = 内置 user 类 + DEFAULT_USER_TOOLS）。 */
    userClass?: ConstructorParameters<typeof Kernel>[0]['userClass']
    /** 上下文策略配置（compact 阈值等；缺省 DEFAULT_CONTEXT_SETTINGS）。 */
    contextSettings?: ContextSettings
    /** 策略注册表（缺省内置 classic/none；测试可注入自定义策略）。 */
    strategies?: StrategyRegistry
    /** 类回写端口（S5.2 测试注入；缺省 = 仅内存注册无落盘）。 */
    classStore?: ConstructorParameters<typeof Kernel>[0]['classStore']
  } = {},
): Promise<Harness> {
  const timers = manualTimers()
  const deliveries = userDeliveryQueue()
  const tools = new DefaultToolCapabilityRegistry()

  const kernel = new Kernel({
    gateway,
    defaultModel: { provider: 'opencode', id: 'test-model' },
    tools,
    templates: opts.templates,
    userClass: opts.userClass,
    defaultCountdownMs: opts.countdownMs ?? 1000,
    timer: timers.timer,
    ...(opts.contextSettings !== undefined ? { contextSettings: opts.contextSettings } : {}),
    ...(opts.strategies !== undefined ? { strategies: opts.strategies } : {}),
    ...(opts.classStore !== undefined ? { classStore: opts.classStore } : {}),
    // 统一事件流：letter 事件 → 收信队列（UserDelivery 形状兼容）。
    onEvent: (e) => {
      if (e.type === 'letter') deliveries.push({ kind: 'user', agentId: e.agentId, letters: e.letters })
    },
  })
  await kernel.registerRootAgent()
  return { kernel, timers, deliveries, tools }
}

export function simpleChatId() {
  return makeAgentClassID('simple-chat')
}

export { USER_ID }
