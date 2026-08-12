// ============================================================
// core/bus/MessageBus.ts —— 通信接口抽象（送信员）
//
// 总线不保存任何消息，按消息 kind 路由：
//   - agent 消息（user_prompt/agent_message/result/system）→ forward（邮局）
//   - log 消息 → onLog（日志订阅者，core/logging）
//
// 职责：参与者注册/注销/查询（user0 + 所有 agent）+ 消息路由。
// ============================================================

import type { LogEvent } from '../logging'

export type ParticipantKind = 'user' | 'agent'

export interface BusParticipant {
  readonly id: string
  /** 'user' = 用户面板（默认 user0）；'agent' = agent 实例。 */
  readonly kind: ParticipantKind
  readonly displayName: string
}

export type BusMessageKind = 'user_prompt' | 'agent_message' | 'result' | 'system' | 'log'

/** agent 通信消息（单目标；一对多通过并行调用多次实现）。 */
export interface AgentBusMessage {
  readonly id: string
  readonly kind: 'user_prompt' | 'agent_message' | 'result' | 'system'
  readonly from: string
  readonly to: string
  readonly payload: string
  readonly at: number
}

/** 日志消息（路由到日志订阅者）。 */
export interface LogBusMessage {
  readonly id: string
  readonly kind: 'log'
  readonly event: LogEvent
  readonly at: number
}

export type BusMessage = AgentBusMessage | LogBusMessage

/** send 入参：id 由总线自动生成。 */
export type BusSendInput = Omit<AgentBusMessage, 'id'> | Omit<LogBusMessage, 'id'>

export interface MessageBus {
  readonly register: (participant: BusParticipant) => Promise<void>
  readonly unregister: (id: string) => Promise<void>
  readonly has: (id: string) => boolean
  readonly listParticipants: () => BusParticipant[]
  /** 发送（按 kind 路由：agent 消息 → forward；log → onLog），id 自动生成。 */
  readonly send: (message: BusSendInput) => Promise<void>
}

export interface MessageBusOptions {
  /** 收到 agent 消息后的转发目标（组合根注入 = 邮局 deposit）。 */
  readonly forward: (message: AgentBusMessage) => Promise<void> | void
  /** 收到 log 消息后的路由目标（组合根注入 = 日志记录器）。 */
  readonly onLog?: (event: LogEvent) => void
}

export class DefaultMessageBus implements MessageBus {
  private readonly participants = new Map<string, BusParticipant>()
  private counter = 0

  constructor(private readonly options: MessageBusOptions) {}

  async register(participant: BusParticipant): Promise<void> {
    if (this.participants.has(participant.id)) {
      throw { kind: 'participant_conflict', id: participant.id }
    }
    this.participants.set(participant.id, participant)
  }

  async unregister(id: string): Promise<void> {
    this.participants.delete(id)
  }

  has(id: string): boolean {
    return this.participants.has(id)
  }

  listParticipants(): BusParticipant[] {
    return [...this.participants.values()]
  }

  async send(message: BusSendInput): Promise<void> {
    const msg = { ...message, id: this.nextId() } as BusMessage
    if (msg.kind === 'log') {
      this.options.onLog?.(msg.event)
    } else {
      await this.options.forward(msg)
    }
  }

  /** 生成消息 id（邮局/上层用）。 */
  nextId(): string {
    return `msg-${++this.counter}`
  }
}
