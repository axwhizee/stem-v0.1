// ============================================================
// core/context/Courier.ts —— 快递员子模块（倒计时 + 发送）
//
// 职责（严格单一）：
//   - 不组装上下文（组装权归管理员：策略要影响真实送信，快递员只消费
//     管理员经 buildAgentDelivery 委托产出的送信快照；user 面板的
//     信件 diff 仍在本模块——那是发送节流状态，不是上下文处理）；
//   - 按 agentId 维护发送倒计时（初始 0 立即发送；发送后开始；
//     倒计时中新内容就绪则重置 —— 合并滑动窗口）；
//   - 收到「上下文待发送事件」（notifyReady，由管理员在策略 process
//     完成后发出）且倒计时就绪时，执行发送。
//
// 发送条件：上下文就绪（管理员处理完成）& 倒计时就绪。
// ============================================================

import type { LogEvent } from '../logging'
import type { Repository } from './Repository'
import type { AgentDelivery, MailDelivery, UserDelivery } from './types'
import type { TimerFactory, TimerHandle } from './wait'
import { DEFAULT_SEND_COUNTDOWN_MS, defaultTimer } from './wait'

export type { TimerFactory, TimerHandle }

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
  /** 仓库（user 面板 diff 读取；agent 送信经管理员委托组装）。 */
  readonly repository: Repository
  /**
   * agent 送信快照构造（组合根注入 = 管理员 buildAgentDelivery，
   * 策略 assemble + legalize 的正规出口；undefined 表示无有效上下文）。
   */
  readonly buildAgentDelivery?: (agentId: string) => AgentDelivery | undefined
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
  /**
   * 倒计时重对账（S10 realign 通道）：构造期恢复接线拿不到空间类的
   * send_countdown（模板表未载 → 落缺省），类载齐后补对齐。
   * 传 undefined = 类未显式配置 → 回收归缺省值；箱不存在 no-op。
   */
  readonly realignCountdown: (agentId: string, sendCountdownMs: number | undefined) => void
  /** 管理员处理完成后的「上下文待发送事件」。 */
  readonly notifyReady: (agentId: string) => Promise<void>
  readonly getState: (agentId: string) => CourierState
  /**
   * agent 送信快照构造（组合根在管理员就绪后注入；同 repository.onChange 模式）。
   * 返回 undefined = 无有效上下文，本轮不发。
   */
  buildAgentDelivery: (agentId: string) => AgentDelivery | undefined
}

interface InternalBox {
  readonly agentId: string
  /** 类装载后仅 realignCountdown 可改（恢复接线时序补偿，见 Courier.realignCountdown）。 */
  sendCountdownMs: number
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
  /** 送信快照构造（组合根注入管理员 buildAgentDelivery；缺省不发 agent 信）。 */
  buildAgentDelivery: (agentId: string) => AgentDelivery | undefined = () => undefined

  constructor(options: CourierOptions) {
    this.defaultCountdownMs = options.defaultCountdownMs ?? DEFAULT_SEND_COUNTDOWN_MS
    this.timer = options.timer ?? defaultTimer
    this.repository = options.repository
    this.onLog = options.onLog
    if (options.buildAgentDelivery !== undefined) this.buildAgentDelivery = options.buildAgentDelivery
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

  realignCountdown(agentId: string, sendCountdownMs: number | undefined): void {
    const box = this.boxes.get(agentId)
    if (!box) return
    box.sendCountdownMs = sendCountdownMs ?? this.defaultCountdownMs
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
    const delivery: MailDelivery | undefined = box.assemble
      ? // agent：送信快照由管理员按该 agent 的上下文策略组装（快递员零组装逻辑）。
        this.buildAgentDelivery(box.agentId)
      : // user 面板/扮演面板：信件 diff（发送节流状态，非上下文处理）。
        this.repository.listValid(box.agentId).length === 0
          ? undefined
          : this.buildUserDelivery(box.agentId)
    if (delivery === undefined) return
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
