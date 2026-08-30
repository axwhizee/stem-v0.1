// ============================================================
// core/context/Courier.ts —— 快递员子模块（倒计时 + 发送）
//
// 职责（严格单一）：
//   - 不参与上下文处理/组装（管理员 ContextManager 的职责）；
//   - 按 agentId 维护发送倒计时（初始 0 立即发送；发送后开始；
//     倒计时中新内容就绪则重置 —— 合并滑动窗口）；
//   - 收到「上下文待发送事件」（notifyReady）且倒计时就绪时，
//     从仓库取有效消息（按顺序）发送给对应 agent / 用户面板。
//
// 发送条件：上下文就绪（管理员已组装/打戳）& 倒计时就绪。
// ============================================================

import type { ChatMessage } from '../gateway'
import type { LogEvent } from '../logging'
import type { Repository } from './Repository'
import type { AgentDelivery, MailDelivery, UserDelivery } from './types'

export interface TimerHandle {
  readonly cancel: () => void
}

export type TimerFactory = (fn: () => void, ms: number) => TimerHandle

const defaultTimer: TimerFactory = (fn, ms) => {
  const handle = setTimeout(fn, ms)
  return { cancel: () => clearTimeout(handle) }
}

export interface CourierRegistration {
  readonly agentId: string
  readonly sendCountdownMs?: number
  /** 发送回调（agent → kernel；user → 面板）。 */
  readonly onDelivery: (delivery: MailDelivery) => void
  /** 倒计时结束但无待发送内容时调用（agent → 进入 hold）。 */
  readonly onHold?: (agentId: string) => void
  /** false = 用户面板（不组装，只汇总信件）。 */
  readonly assemble?: boolean
  /**
   * 恢复接线：已发送消息 id 预置（持久化重启后 lastSentIds 不再为空，
   * 面板不会把历史旧信当新信重放）。
   */
  readonly initialSentIds?: readonly string[]
}

export interface CourierOptions {
  readonly defaultCountdownMs?: number
  readonly timer?: TimerFactory
  /** 仓库（发送时按有效性取消息）。 */
  readonly repository: Repository
  /** 日志出口（组合根注入 → core/logging）。 */
  readonly onLog?: (event: LogEvent) => void
}

export interface CourierState {
  readonly agentId: string
  readonly sendCountdownMs: number
  /** 是否处于倒计时（送信合并窗口）中。 */
  readonly coolingDown: boolean
  /** 是否有待发送的就绪信号。 */
  readonly pending: boolean
}

export interface Courier {
  readonly register: (registration: CourierRegistration) => Promise<void>
  readonly unregister: (agentId: string) => Promise<void>
  /** 管理员处理完成后的「上下文待发送事件」。 */
  readonly notifyReady: (agentId: string) => Promise<void>
  readonly getState: (agentId: string) => CourierState
}

interface InternalBox {
  readonly agentId: string
  readonly sendCountdownMs: number
  readonly onDelivery: (delivery: MailDelivery) => void
  readonly onHold?: (agentId: string) => void
  readonly assemble: boolean
  /** 就绪信号（管理员已完成处理，等待倒计时）。 */
  ready: boolean
  /** 上次发送的消息 id 集（供 user 面板 diff 信件）。 */
  lastSentIds: readonly string[]
  timer: TimerHandle | undefined
  coolingDown: boolean
}

export class DefaultCourier implements Courier {
  private readonly boxes = new Map<string, InternalBox>()
  private readonly defaultCountdownMs: number
  private readonly timer: TimerFactory
  private readonly repository: Repository
  private readonly onLog?: (event: LogEvent) => void

  constructor(options: CourierOptions) {
    this.defaultCountdownMs = options.defaultCountdownMs ?? 1000
    this.timer = options.timer ?? defaultTimer
    this.repository = options.repository
    this.onLog = options.onLog
  }

  async register(registration: CourierRegistration): Promise<void> {
    if (this.boxes.has(registration.agentId)) {
      throw { kind: 'courier_conflict', agentId: registration.agentId }
    }
    this.boxes.set(registration.agentId, {
      agentId: registration.agentId,
      sendCountdownMs: registration.sendCountdownMs ?? this.defaultCountdownMs,
      onDelivery: registration.onDelivery,
      onHold: registration.onHold,
      assemble: registration.assemble ?? true,
      ready: false,
      lastSentIds: registration.initialSentIds ?? [],
      timer: undefined,
      coolingDown: false,
    })
  }

  async unregister(agentId: string): Promise<void> {
    const box = this.boxes.get(agentId)
    if (!box) return
    box.timer?.cancel()
    this.boxes.delete(agentId)
  }

  async notifyReady(agentId: string): Promise<void> {
    const box = this.require(agentId)
    box.ready = true
    if (box.coolingDown) {
      // 倒计时中 → 重置（合并窗口滑动，发送最新内容）。
      this.emit({ type: 'mailbox.countdown', at: Date.now(), agentId, action: 'reset' })
      box.timer?.cancel()
      box.timer = this.timer(() => this.onCountdown(box), box.sendCountdownMs)
      return
    }
    // 无倒计时（首信 / holding 中来信 / 填充就绪）→ 立即发送。
    this.deliver(box)
  }

  getState(agentId: string): CourierState {
    const box = this.require(agentId)
    return {
      agentId: box.agentId,
      sendCountdownMs: box.sendCountdownMs,
      coolingDown: box.coolingDown,
      pending: box.ready,
    }
  }

  private deliver(box: InternalBox): void {
    box.ready = false
    // 从仓库取有效消息（按顺序）。
    const valid = this.repository.listValid(box.agentId)
    if (valid.length === 0) return
    const delivery: MailDelivery = box.assemble ? this.buildAgentDelivery(box.agentId, valid) : this.buildUserDelivery(box.agentId)
    this.emit({
      type: 'mailbox.delivered',
      at: Date.now(),
      agentId: box.agentId,
      kind: delivery.kind,
      messageCount: delivery.kind === 'agent' ? delivery.messages.length : delivery.letters.length,
    })
    box.onDelivery(delivery)
    this.startCountdown(box)
  }

  private buildAgentDelivery(agentId: string, valid: readonly import('./types').StoredMessage[]): AgentDelivery {
    const systemIndex = valid.findIndex((m) => m.message.role === 'system')
    const system = systemIndex >= 0 ? contentOf(valid[systemIndex]!.message) : ''
    const rest = valid.filter((m) => m.message.role !== 'system')
    return {
      kind: 'agent',
      agentId,
      system,
      messages: rest.map((m) => m.message),
      messageIds: valid.map((m) => m.id),
    }
  }

  private buildUserDelivery(agentId: string): UserDelivery {
    const valid = this.repository.listValid(agentId)
    // user 面板：只汇总新信件（自上次发送后新增的 user 消息）。
    const last = new Set(this.require(agentId).lastSentIds)
    const fresh = valid.filter((m) => !last.has(m.id) && m.message.role === 'user')
    this.require(agentId).lastSentIds = valid.map((m) => m.id)
    return { kind: 'user', agentId, letters: fresh.map((m) => m.message) }
  }

  private startCountdown(box: InternalBox): void {
    this.emit({ type: 'mailbox.countdown', at: Date.now(), agentId: box.agentId, action: 'start' })
    box.coolingDown = true
    box.timer?.cancel()
    box.timer = this.timer(() => this.onCountdown(box), box.sendCountdownMs)
  }

  private onCountdown(box: InternalBox): void {
    box.timer = undefined
    box.coolingDown = false
    // 送信条件：倒计时就绪 & 有待发送信号（上下文就绪）。
    if (box.ready) {
      this.emit({ type: 'mailbox.countdown', at: Date.now(), agentId: box.agentId, action: 'fire' })
      this.deliver(box)
    } else {
      this.emit({ type: 'mailbox.countdown', at: Date.now(), agentId: box.agentId, action: 'hold' })
      box.onHold?.(box.agentId)
    }
  }

  private emit(event: LogEvent): void {
    this.onLog?.(event)
  }

  private require(agentId: string): InternalBox {
    const box = this.boxes.get(agentId)
    if (!box) throw { kind: 'courier_not_found', agentId }
    return box
  }
}

function contentOf(message: ChatMessage): string {
  return typeof message.content === 'string' ? message.content : ''
}
