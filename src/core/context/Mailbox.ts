// ============================================================
// core/context/Mailbox.ts —— 邮箱子模块（发送判定 + 倒计时）
//
// 职责（严格单一）：
//   - 不参与上下文拼装（拼装是 ContextManager 的职责）；
//   - 只负责等待「上下文就绪信号 + 倒计时就绪」两个条件，然后
//     向指定 agentId 发送消息（agent 收到完整上下文 / user 收到信件汇总）。
//
// 就绪信号来源：ContextManager 在拼装/汇总出新的「待发送内容」后
// 调用 notifyReady(agentId, content)。Mailbox 持有最新待发送内容，
// 并管理送信倒计时（初始 0 立即送信；发送后开始倒计时；倒计时中新
// 内容到达则重置倒计时 —— 合并滑动窗口）。倒计时结束仍有待发送内容
// 则发送，否则 onHold。
// ============================================================

import type { ChatMessage, ToolDefinition } from '../gateway'
import type { LogEvent } from '../logging'
import type { AgentDelivery, MailDelivery, UserDelivery } from './types'

export interface TimerHandle {
  readonly cancel: () => void
}

export type TimerFactory = (fn: () => void, ms: number) => TimerHandle

const defaultTimer: TimerFactory = (fn, ms) => {
  const handle = setTimeout(fn, ms)
  return { cancel: () => clearTimeout(handle) }
}

/** 待发送内容：ContextManager 拼装（agent）/ 汇总（user）完成后交给邮箱。 */
export type ReadyContent =
  | {
      readonly kind: 'context'
      readonly system: string
      readonly messages: readonly ChatMessage[]
      readonly tools?: readonly ToolDefinition[]
    }
  | { readonly kind: 'letters'; readonly letters: readonly ChatMessage[] }

export interface MailboxRegistration {
  readonly agentId: string
  readonly sendCountdownMs?: number
  /** 发送回调（agent → kernel；user → 面板）。 */
  readonly onDelivery: (delivery: MailDelivery) => void
  /** 倒计时结束但无待发送内容时调用（agent → 进入 hold）。 */
  readonly onHold?: (agentId: string) => void
  /** 发送前回调（ContextManager 注入：消费已就绪的信件/填充标记）。 */
  readonly beforeSend: (agentId: string) => void
}

export interface MailboxState {
  readonly agentId: string
  readonly sendCountdownMs: number
  /** 是否处于倒计时（送信合并窗口）中。 */
  readonly coolingDown: boolean
  /** 是否有待发送的就绪内容。 */
  readonly pending: boolean
}

export interface MailboxOptions {
  readonly defaultCountdownMs?: number
  readonly timer?: TimerFactory
  /** 日志出口（组合根注入 → bus → core/logging）。 */
  readonly onLog?: (event: LogEvent) => void
}

export interface Mailbox {
  readonly register: (registration: MailboxRegistration) => Promise<void>
  readonly unregister: (agentId: string) => Promise<void>
  /** ContextManager 在拼装/汇总出新内容时调用（就绪信号 + 内容）。 */
  readonly notifyReady: (agentId: string, content: ReadyContent) => Promise<void>
  readonly getState: (agentId: string) => MailboxState
}

interface InternalBox {
  readonly agentId: string
  readonly sendCountdownMs: number
  readonly onDelivery: (delivery: MailDelivery) => void
  readonly onHold?: (agentId: string) => void
  readonly beforeSend: (agentId: string) => void
  timer: TimerHandle | undefined
  /** 是否处于倒计时中（送信合并窗口）。 */
  coolingDown: boolean
  /** 待发送内容（就绪信号 + 完整上下文/信件汇总）。 */
  ready: ReadyContent | undefined
}

export class DefaultMailbox implements Mailbox {
  private readonly boxes = new Map<string, InternalBox>()
  private readonly defaultCountdownMs: number
  private readonly timer: TimerFactory
  private readonly onLog?: (event: LogEvent) => void

  constructor(options: MailboxOptions = {}) {
    this.defaultCountdownMs = options.defaultCountdownMs ?? 1000
    this.timer = options.timer ?? defaultTimer
    this.onLog = options.onLog
  }

  async register(registration: MailboxRegistration): Promise<void> {
    if (this.boxes.has(registration.agentId)) {
      throw { kind: 'mailbox_conflict', agentId: registration.agentId }
    }
    this.boxes.set(registration.agentId, {
      agentId: registration.agentId,
      sendCountdownMs: registration.sendCountdownMs ?? this.defaultCountdownMs,
      onDelivery: registration.onDelivery,
      onHold: registration.onHold,
      beforeSend: registration.beforeSend,
      timer: undefined,
      coolingDown: false,
      ready: undefined,
    })
  }

  async unregister(agentId: string): Promise<void> {
    const box = this.boxes.get(agentId)
    if (!box) return
    box.timer?.cancel()
    this.boxes.delete(agentId)
  }

  async notifyReady(agentId: string, content: ReadyContent): Promise<void> {
    const box = this.require(agentId)
    box.ready = content
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

  getState(agentId: string): MailboxState {
    const box = this.require(agentId)
    return {
      agentId: box.agentId,
      sendCountdownMs: box.sendCountdownMs,
      coolingDown: box.coolingDown,
      pending: box.ready !== undefined,
    }
  }

  private deliver(box: InternalBox): void {
    const content = box.ready
    box.ready = undefined
    if (content === undefined) return
    // 发送前通知 ContextManager 消费（信件并入历史 / 清空填充标记）。
    box.beforeSend(box.agentId)
    const delivery: MailDelivery =
      content.kind === 'context'
        ? {
            kind: 'agent',
            agentId: box.agentId,
            system: content.system,
            messages: content.messages,
            tools: content.tools,
          }
        : { kind: 'user', agentId: box.agentId, letters: content.letters }
    this.emit({
      type: 'mailbox.delivered',
      at: Date.now(),
      agentId: box.agentId,
      kind: delivery.kind,
      messageCount: content.kind === 'context' ? content.messages.length : content.letters.length,
    })
    box.onDelivery(delivery)
    this.startCountdown(box)
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
    // 送信条件：倒计时就绪 & 有待发送内容（上下文就绪）。
    if (box.ready !== undefined) {
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
    if (!box) throw { kind: 'mailbox_not_found', agentId }
    return box
  }
}
