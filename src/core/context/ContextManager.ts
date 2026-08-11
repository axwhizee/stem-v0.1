// ============================================================
// core/context/ContextManager.ts —— 上下文管理器（邮局）
//
// 所有上下文成分异步就绪、按 agentId 分箱累积：
//   - system_prompt：实例化时 register
//   - 信件（user_prompt）：deposit（用户/agent 投信）
//   - assistant_history：appendHistory（runtime 自动复制）
//   - tool 记录：appendToolRecord（工具模块自动发送）
//
// 送信倒计时（邮局维护的局部量）：
//   - 初始为 0：首信到达立即组装送信
//   - 发送完一次上下文后才开始倒计时；cooldown 中新信重置倒计时
//   - 倒计时结束：可组装（有信）→ 组装送信；不可组装 → onHold
//
// 用户（assemble=false）不做组装，只把信件汇总送信。
// 存储：内存 JSON 消息列表（后续换 SQLite，接口已隔离）。
// ============================================================

import type { ChatMessage } from '../gateway'
import type { ToolRecord } from '../tools'
import type { ContextAssembler } from './ContextAssembler'
import type { AgentDelivery, MailboxState, MailDelivery, UserDelivery } from './types'

export interface TimerHandle {
  readonly cancel: () => void
}

export type TimerFactory = (fn: () => void, ms: number) => TimerHandle

const defaultTimer: TimerFactory = (fn, ms) => {
  const handle = setTimeout(fn, ms)
  return { cancel: () => clearTimeout(handle) }
}

export interface MailboxRegistration {
  readonly agentId: string
  readonly systemPrompt?: string
  readonly sendCountdownMs?: number
  /** false = 用户面板（user0）。 */
  readonly assemble?: boolean
  /** 送信回调（agent → kernel；user → 面板）。 */
  readonly onDelivery: (delivery: MailDelivery) => void
  /** 倒计时结束但无信可组装时调用（agent → 进入 hold）。 */
  readonly onHold?: (agentId: string) => void
}

interface InternalMailbox {
  readonly agentId: string
  systemPrompt: string | undefined
  readonly context: ChatMessage[]
  pendingLetters: ChatMessage[]
  readonly toolRecords: ToolRecord[]
  sendCountdownMs: number
  readonly assemble: boolean
  readonly onDelivery: (delivery: MailDelivery) => void
  readonly onHold?: (agentId: string) => void
  timer: TimerHandle | undefined
  /** 是否处于 cooldown（倒计时中）。 */
  coolingDown: boolean
}

export interface ContextManagerOptions {
  readonly assembler: ContextAssembler
  readonly defaultCountdownMs?: number
  readonly timer?: TimerFactory
}

export interface ContextManager {
  readonly register: (registration: MailboxRegistration) => Promise<void>
  readonly unregister: (agentId: string) => Promise<void>
  /** 投信：追加信件 + 触发送信/重置倒计时。 */
  readonly deposit: (agentId: string, letter: ChatMessage) => Promise<void>
  /** 追加历史（runtime 复制 assistant；工具模块注入 tool 结果）。 */
  readonly appendHistory: (agentId: string, message: ChatMessage) => Promise<void>
  /** 工具调用审计记录（工具模块自动发送）。 */
  readonly appendToolRecord: (agentId: string, record: ToolRecord) => Promise<void>
  readonly getState: (agentId: string) => MailboxState
}

export class DefaultContextManager implements ContextManager {
  private readonly boxes = new Map<string, InternalMailbox>()
  private readonly assembler: ContextAssembler
  private readonly defaultCountdownMs: number
  private readonly timer: TimerFactory

  constructor(options: ContextManagerOptions) {
    this.assembler = options.assembler
    this.defaultCountdownMs = options.defaultCountdownMs ?? 1000
    this.timer = options.timer ?? defaultTimer
  }

  async register(registration: MailboxRegistration): Promise<void> {
    if (this.boxes.has(registration.agentId)) {
      throw { kind: 'mailbox_conflict', agentId: registration.agentId }
    }
    this.boxes.set(registration.agentId, {
      agentId: registration.agentId,
      systemPrompt: registration.systemPrompt,
      context: [],
      pendingLetters: [],
      toolRecords: [],
      sendCountdownMs: registration.sendCountdownMs ?? this.defaultCountdownMs,
      assemble: registration.assemble ?? true,
      onDelivery: registration.onDelivery,
      onHold: registration.onHold,
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

  async deposit(agentId: string, letter: ChatMessage): Promise<void> {
    const box = this.require(agentId)
    box.pendingLetters.push(letter)

    if (box.coolingDown) {
      // cooldown 中 → 重置倒计时（合并窗口滑动）
      box.timer?.cancel()
      box.timer = this.timer(() => this.onCountdown(box), box.sendCountdownMs)
      return
    }
    // 无倒计时（首信 / hold 中）→ 立即送信
    this.deliver(box)
  }

  async appendHistory(agentId: string, message: ChatMessage): Promise<void> {
    const box = this.require(agentId)
    box.context.push(message)
  }

  async appendToolRecord(agentId: string, record: ToolRecord): Promise<void> {
    const box = this.require(agentId)
    box.toolRecords.push(record)
  }

  getState(agentId: string): MailboxState {
    const box = this.require(agentId)
    return {
      agentId: box.agentId,
      systemPrompt: box.systemPrompt,
      context: [...box.context],
      pendingLetters: [...box.pendingLetters],
      toolRecords: [...box.toolRecords],
      sendCountdownMs: box.sendCountdownMs,
      assemble: box.assemble,
    }
  }

  private deliver(box: InternalMailbox): void {
    if (box.assemble) {
      // 信件并入历史后组装，再送信
      const letters = [...box.pendingLetters]
      box.pendingLetters = []
      box.context.push(...letters)
      const system = box.systemPrompt ?? ''
      const assembled = this.assembler.assemble({ systemPrompt: system, context: box.context })
      const delivery: AgentDelivery = {
        kind: 'agent',
        agentId: box.agentId,
        system: assembled.system,
        messages: assembled.messages,
        tools: assembled.tools,
      }
      box.onDelivery(delivery)
    } else {
      const letters = [...box.pendingLetters]
      box.pendingLetters = []
      const delivery: UserDelivery = { kind: 'user', agentId: box.agentId, letters }
      box.onDelivery(delivery)
    }
    this.startCountdown(box)
  }

  private startCountdown(box: InternalMailbox): void {
    box.coolingDown = true
    box.timer?.cancel()
    box.timer = this.timer(() => this.onCountdown(box), box.sendCountdownMs)
  }

  private onCountdown(box: InternalMailbox): void {
    box.timer = undefined
    box.coolingDown = false
    if (box.pendingLetters.length > 0) {
      this.deliver(box)
    } else {
      box.onHold?.(box.agentId)
    }
  }

  private require(agentId: string): InternalMailbox {
    const box = this.boxes.get(agentId)
    if (!box) throw { kind: 'mailbox_not_found', agentId }
    return box
  }
}
