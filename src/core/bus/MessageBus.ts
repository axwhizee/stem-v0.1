// ============================================================
// core/bus/MessageBus.ts —— 送信员（薄层）
//
// 总线不保存任何消息：send 直接把信件转发给"邮局"（ContextManager）。
// 职责：参与者注册/注销/查询（user0 + 所有 agent）+ 消息转发。
// 保留理由：未来广播/审计/多 user 等扩展点。
// ============================================================

export type ParticipantKind = 'user' | 'agent'

export interface BusParticipant {
  readonly id: string
  /** 'user' = 用户面板（默认 user0）；'agent' = agent 实例。 */
  readonly kind: ParticipantKind
  readonly displayName: string
}

export type BusMessageKind = 'user_prompt' | 'agent_message' | 'result' | 'system'

export interface BusMessage {
  readonly id: string
  readonly kind: BusMessageKind
  readonly from: string
  /** 单目标；一对多通过并行调用多次实现。 */
  readonly to: string
  readonly payload: string
  readonly at: number
}

/** send 入参：id 由总线自动生成。 */
export type BusSendInput = Omit<BusMessage, 'id'>

export interface MessageBus {
  readonly register: (participant: BusParticipant) => Promise<void>
  readonly unregister: (id: string) => Promise<void>
  readonly has: (id: string) => boolean
  readonly listParticipants: () => BusParticipant[]
  /** 发送（转发给邮局），id 自动生成。 */
  readonly send: (message: BusSendInput) => Promise<void>
}

export interface MessageBusOptions {
  /** 收到消息后的转发目标（组合根注入 = 邮局 deposit）。 */
  readonly forward: (message: BusMessage) => Promise<void> | void
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
    await this.options.forward({ ...message, id: this.nextId() })
  }

  /** 生成消息 id（邮局/上层用）。 */
  nextId(): string {
    return `msg-${++this.counter}`
  }
}
