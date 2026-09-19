// ============================================================
// core/context/wait.ts —— 统一挂起原语（事件 + 倒计时 + 中断）
//
// 三套挂起键：
//   - waitForReply  = wait('reply:'+sender)（策略 spawn 信箱配对）
//   - instantiate.wait = wait('hold:'+childId)（仅超时自回填；deposit 独占消费在 ContextManager.holds）
//   - agent_pause   = wait('timer:'+toolCallId)（纯倒计时）
// deposit 一次 emit('reply:'+from, letter) 兑现全部同键等待者。
// cancelOwner 挂 unregister/terminate；timer 经注入 TimerFactory（core 零平台依赖）。
// ============================================================

export interface TimerHandle {
  readonly cancel: () => void
}

export type TimerFactory = (fn: () => void, ms: number) => TimerHandle

/** 缺省计时器（setTimeout 包装；Courier/ContextManager/runtime 共用一份）。 */
export const defaultTimer: TimerFactory = (fn, ms) => {
  const handle = setTimeout(fn, ms)
  return { cancel: () => clearTimeout(handle) }
}

/** 送信合并窗口缺省（毫秒）。 */
export const DEFAULT_SEND_COUNTDOWN_MS = 1000

export type WaitResult<T = unknown> =
  | { readonly kind: 'event'; readonly payload: T }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'aborted' }

export interface WaitOptions {
  /** 事件键（emit 对账）。 */
  readonly key: string
  /** 等待者归属（cancelOwner / terminate 清理单位）。 */
  readonly owner: string
  /** 倒计时超时（毫秒；缺省 = 无限等）。 */
  readonly timeoutMs?: number
  /** 外部中断（runtime abort 等）。 */
  readonly signal?: AbortSignal
}

export interface Waiter {
  /** 登记等待并挂起至事件/超时/中断。 */
  wait<T = unknown>(options: WaitOptions): Promise<WaitResult<T>>
  /** 兑现同键全部等待者；有命中返回 true。 */
  emit(key: string, payload: unknown): boolean
  /** 注销某 owner 的全部等待（兑现为 aborted）。 */
  cancelOwner(owner: string): void
  /** 注销指定键（可选再按 owner 收窄）的等待。 */
  cancel(key: string, owner?: string): void
}

interface WaiterEntry {
  readonly key: string
  readonly owner: string
  readonly settle: (result: WaitResult) => void
  timer?: TimerHandle
  signal?: AbortSignal
  onAbort?: () => void
}

function indexAdd(map: Map<string, Set<WaiterEntry>>, key: string, entry: WaiterEntry): void {
  let set = map.get(key)
  if (set === undefined) {
    set = new Set()
    map.set(key, set)
  }
  set.add(entry)
}

function indexDrop(map: Map<string, Set<WaiterEntry>>, key: string, entry: WaiterEntry): void {
  const set = map.get(key)
  if (set === undefined) return
  set.delete(entry)
  if (set.size === 0) map.delete(key)
}

export class DefaultWaiter implements Waiter {
  private readonly byKey = new Map<string, Set<WaiterEntry>>()
  private readonly byOwner = new Map<string, Set<WaiterEntry>>()
  private readonly timer: TimerFactory

  constructor(timer: TimerFactory = defaultTimer) {
    this.timer = timer
  }

  wait<T = unknown>(options: WaitOptions): Promise<WaitResult<T>> {
    return new Promise<WaitResult<T>>((resolve) => {
      let settled = false
      const entry: WaiterEntry = {
        key: options.key,
        owner: options.owner,
        settle: (result) => {
          if (settled) return
          settled = true
          indexDrop(this.byKey, entry.key, entry)
          indexDrop(this.byOwner, entry.owner, entry)
          entry.timer?.cancel()
          entry.timer = undefined
          if (entry.signal !== undefined && entry.onAbort !== undefined) {
            entry.signal.removeEventListener('abort', entry.onAbort)
          }
          resolve(result as WaitResult<T>)
        },
      }
      indexAdd(this.byKey, options.key, entry)
      indexAdd(this.byOwner, options.owner, entry)
      if (options.timeoutMs !== undefined) {
        entry.timer = this.timer(() => entry.settle({ kind: 'timeout' }), options.timeoutMs)
      }
      if (options.signal !== undefined) {
        if (options.signal.aborted) {
          entry.settle({ kind: 'aborted' })
          return
        }
        const onAbort = (): void => entry.settle({ kind: 'aborted' })
        entry.signal = options.signal
        entry.onAbort = onAbort
        options.signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  emit(key: string, payload: unknown): boolean {
    const set = this.byKey.get(key)
    if (set === undefined || set.size === 0) return false
    for (const entry of [...set]) {
      entry.settle({ kind: 'event', payload })
    }
    return true
  }

  cancelOwner(owner: string): void {
    const set = this.byOwner.get(owner)
    if (set === undefined) return
    for (const entry of [...set]) {
      entry.settle({ kind: 'aborted' })
    }
  }

  cancel(key: string, owner?: string): void {
    const set = this.byKey.get(key)
    if (set === undefined) return
    for (const entry of [...set]) {
      if (owner === undefined || entry.owner === owner) {
        entry.settle({ kind: 'aborted' })
      }
    }
  }
}

/** 键工厂（调用点与 deposit 共用，防字符串漂移）。 */
export const waitKeys = {
  reply: (fromId: string): string => `reply:${fromId}`,
  hold: (waitFor: string): string => `hold:${waitFor}`,
  timer: (toolCallId: string): string => `timer:${toolCallId}`,
} as const
