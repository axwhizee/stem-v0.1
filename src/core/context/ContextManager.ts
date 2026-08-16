// ============================================================
// core/context/ContextManager.ts —— 管理员子模块（上下文处理）
//
// 职责（重建邮局的逻辑层）：
//   - 收到「上下文待处理事件」（仓库 onChange）→ 处理该 agent：
//       1. context_wait 判定：from 命中挂起等待 → 作为 tool 结果填充到 owner；
//       2. 打发送者戳：user 消息累积时用 from 元数据生成 `<sender id=...>`；
//       3. 组装（classic/coding-hybrid 模式，可注入策略）；
//       4. 通知快递员「上下文待发送事件」。
//   - 打标签（发送者戳）行为由本模块完成，而非 kernel（D11 分层）。
//
// 存储交给仓库（Repository），发送交给快递员（Courier）。
// ============================================================

import type { ChatMessage } from '../gateway'
import type { LogEvent } from '../logging'
import type { ToolRecord } from '../tools'
import type { Courier, CourierRegistration } from './Courier'
import type { Repository } from './Repository'
import type { AssembleInput, AssembleResult, ContextAssembler, MailDelivery, RepositoryState } from './types'
import { classicAssemble } from './types'

export interface ContextManagerOptions {
  /** 组装策略（缺省经典组装 classicAssemble）。 */
  readonly contextAssembler?: ContextAssembler
  readonly defaultCountdownMs?: number
  readonly timer?: import('./Courier').TimerFactory
  /** 仓库（组合根注入）。 */
  readonly repository: Repository
  /** 快递员（组合根注入）。 */
  readonly courier: Courier
  /** 日志出口（组合根注入 → core/logging）。 */
  readonly onLog?: (event: LogEvent) => void
}

/** 实例化时注册（成分信息 + 发送回调）。 */
export interface ContextRegistration {
  readonly agentId: string
  readonly systemPrompt?: string
  readonly sendCountdownMs?: number
  /** false = 用户面板（user0，不组装只汇总）。 */
  readonly assemble?: boolean
  /** 送信回调（agent → kernel；user → 面板）。 */
  readonly onDelivery: (delivery: MailDelivery) => void
  /** 倒计时结束但无信可送时调用（agent → 进入 hold）。 */
  readonly onHold?: (agentId: string) => void
}

interface InternalBox {
  readonly agentId: string
  readonly assemble: boolean
  /** 挂起等待：waitFor agent id → 挂起记录。 */
  readonly pendingFills: Map<string, { waitFor: string; ownerId: string; toolCallId: string }>
  /** 各成分最近就绪时间（毫秒，供日志）。 */
  lastLetterAt: number | undefined
  lastHistoryAt: number | undefined
  lastToolAt: number | undefined
}

export interface ContextManager {
  readonly register: (registration: ContextRegistration) => Promise<void>
  readonly unregister: (agentId: string) => Promise<void>
  /**
   * 投信（from 为发送者 id，用于打戳与 context_wait 分流）。
   * 若 from 命中挂起等待 → 作为 tool 结果填充到等待者上下文（非 user_prompt）。
   */
  readonly deposit: (agentId: string, letter: ChatMessage, from?: string) => Promise<void>
  /** 注册挂起等待：等待 waitFor 的回复作为 tool 结果填充到 owner 上下文。 */
  readonly registerHold: (waitFor: string, opts: { ownerId: string; toolCallId: string }) => Promise<void>
  /** 追加历史（runtime 复制 assistant；工具模块注入 tool 结果）。tag 可选标记合成消息。 */
  readonly appendHistory: (agentId: string, message: ChatMessage, tag?: string) => Promise<void>
  /** 工具调用审计记录（工具模块自动发送）。 */
  readonly appendToolRecord: (agentId: string, record: ToolRecord) => Promise<void>
  readonly getState: (agentId: string) => Promise<RepositoryState>
  /** 底层仓库（供 kernel/工具读取）。 */
  readonly repository: Repository
  /** 仓库 onChange 处理入口（组合根装配时注入给仓库）。 */
  readonly handleChange: (agentId: string) => void
  /**
   * 导出完整上下文为 jsonl（逐行 JSON，含 tag/turn/indexInTurn）。
   * 纯数据转换，无权限概念（权限由 Kernel 层编排）。
   */
  readonly exportJsonl: (agentId: string) => Promise<string>
  /**
   * 上下文概览（只读反射）：每条消息的 role / turn / tag / token 占比 / 索引。
   * 纯数据转换，无权限概念。
   */
  readonly overview: (agentId: string) => Promise<string>
}

export class DefaultContextManager implements ContextManager {
  readonly repository: Repository
  private readonly boxes = new Map<string, InternalBox>()
  private readonly assemble: ContextAssembler
  private readonly courier: Courier
  private readonly onLog?: (event: LogEvent) => void

  constructor(options: ContextManagerOptions) {
    this.assemble = options.contextAssembler ?? classicAssemble
    this.repository = options.repository
    this.courier = options.courier
    this.onLog = options.onLog
  }

  async register(registration: ContextRegistration): Promise<void> {
    if (this.boxes.has(registration.agentId)) {
      throw { kind: 'mailbox_conflict', agentId: registration.agentId }
    }
    const box: InternalBox = {
      agentId: registration.agentId,
      assemble: registration.assemble ?? true,
      pendingFills: new Map(),
      lastLetterAt: undefined,
      lastHistoryAt: undefined,
      lastToolAt: undefined,
    }
    this.boxes.set(registration.agentId, box)

    // 仓库开辟记录（systemPrompt 作为首条 system message）。
    await this.repository.register(registration.agentId, registration.systemPrompt)

    // 快递员注册。
    const courierRegistration: CourierRegistration = {
      agentId: registration.agentId,
      sendCountdownMs: registration.sendCountdownMs,
      onDelivery: registration.onDelivery,
      onHold: registration.onHold,
      assemble: registration.assemble,
    }
    await this.courier.register(courierRegistration)
  }

  async unregister(agentId: string): Promise<void> {
    await this.courier.unregister(agentId)
    await this.repository.unregister(agentId)
    this.boxes.delete(agentId)
  }

  async registerHold(waitFor: string, opts: { ownerId: string; toolCallId: string }): Promise<void> {
    const box = this.require(opts.ownerId)
    box.pendingFills.set(waitFor, { waitFor, ownerId: opts.ownerId, toolCallId: opts.toolCallId })
  }

  async deposit(agentId: string, letter: ChatMessage, from?: string): Promise<void> {
    // context_wait 分流：发送者命中挂起等待 → 该回复作为 tool 结果填充（非信件）。
    if (from !== undefined) {
      const pending = this.findPendingFor(from)
      if (pending) {
        const owner = this.require(pending.ownerId)
        owner.pendingFills.delete(from)
        owner.lastHistoryAt = Date.now()
        await this.repository.append(pending.ownerId, {
          message: { role: 'tool', content: letter.content, toolCallId: pending.toolCallId },
        })
        return
      }
    }
    const box = this.require(agentId)
    box.lastLetterAt = Date.now()
    // 先入库（含 from），管理员处理时统一打戳。
    await this.repository.append(agentId, { message: letter, from })
  }

  async appendHistory(agentId: string, message: ChatMessage, tag?: string): Promise<void> {
    const box = this.require(agentId)
    box.lastHistoryAt = Date.now()
    await this.repository.append(agentId, { message, ...(tag !== undefined ? { tag } : {}) })
  }

  async appendToolRecord(agentId: string, record: ToolRecord): Promise<void> {
    const box = this.require(agentId)
    box.lastToolAt = Date.now()
    // 工具审计记录仅占位（工具调用日志由工具模块经 LogSink 上报，见 Kernel 装配）。
  }

  async getState(agentId: string): Promise<RepositoryState> {
    return this.repository.getState(agentId)
  }

  async exportJsonl(agentId: string): Promise<string> {
    const state = await this.repository.getState(agentId)
    return state.messages
      .map((m) =>
        JSON.stringify({
          id: m.id,
          role: m.message.role,
          content: String(m.message.content),
          at: m.at,
          tokens: m.tokens,
          valid: m.valid,
          ...(m.from !== undefined ? { from: m.from } : {}),
          ...(m.tag !== undefined ? { tag: m.tag } : {}),
          turn: m.turn,
          indexInTurn: m.indexInTurn,
        }),
      )
      .join('\n')
  }

  async overview(agentId: string): Promise<string> {
    const state = await this.repository.getState(agentId)
    const total = state.messages.reduce((sum, m) => sum + m.tokens, 0) || 1
    const lines = state.messages.map((m) => {
      const pct = ((m.tokens / total) * 100).toFixed(1)
      const content = String(m.message.content)
      return `[${m.turn}:${m.indexInTurn}] ${m.message.role}${m.tag !== undefined ? ` <${m.tag}>` : ''} ${m.tokens}tok(${pct}%) ${content.slice(0, 60)}${content.length > 60 ? '…' : ''}`
    })
    return `上下文概览 ${agentId}（${state.messages.length} 条，${total} tok）:\n${lines.join('\n')}`
  }

  /** 仓库 onChange 入口：打戳 + 组装 + 通知快递员。 */
  readonly handleChange: (agentId: string) => void = (agentId) => {
    const box = this.boxes.get(agentId)
    if (!box) return
    // 1. 打发送者戳（把所有未打戳的 user 消息补上戳）。
    this.applyStamps(box)
    // 2. 组装快照（供日志）。
    const assembled = this.snapshot(box)
    // 3. 通知快递员「上下文待发送事件」。
    void this.courier.notifyReady(agentId)
    if (assembled !== undefined) {
      this.onLog?.({
        type: 'context.assembled',
        at: Date.now(),
        agentId,
        assemble: box.assemble,
        messageCount: assembled.messageIds.length,
        messages: assembled.messages,
        readyAt: {
          letters: box.lastLetterAt,
          history: box.lastHistoryAt,
          tools: box.lastToolAt,
        },
      })
    }
  }

  /** 把所有未打戳的 user 消息（含 from）补上发送者戳。 */
  private applyStamps(box: InternalBox): void {
    const valid = this.repository.listValid(box.agentId)
    for (const stored of valid) {
      if (stored.from === undefined || stored.message.role !== 'user') continue
      const text = contentOf(stored.message)
      if (text.startsWith('<sender id=')) continue // 已打戳
      const stamped: ChatMessage = { role: 'user', content: `<sender id="${stored.from}">${text}</sender>` }
      void this.repository.updateMessage(box.agentId, stored.id, stamped)
    }
  }

  /** 组装（agent）或汇总（user）：返回本次快照供日志。 */
  private snapshot(box: InternalBox): AssembleResult | undefined {
    const valid = this.repository.listValid(box.agentId)
    if (valid.length === 0) return undefined
    if (!box.assemble) {
      // user0：只汇总信件。
      const letters = valid.filter((m) => m.message.role === 'user')
      return { system: '', messages: letters.map((m) => m.message), messageIds: letters.map((m) => m.id) }
    }
    return this.assemble({ agentId: box.agentId, messages: valid } as AssembleInput)
  }

  private findPendingFor(senderId: string): { ownerId: string; toolCallId: string } | undefined {
    for (const box of this.boxes.values()) {
      const pending = box.pendingFills.get(senderId)
      if (pending) return pending
    }
    return undefined
  }

  private require(agentId: string): InternalBox {
    const box = this.boxes.get(agentId)
    if (!box) throw { kind: 'mailbox_not_found', agentId }
    return box
  }
}

function contentOf(message: ChatMessage): string {
  return typeof message.content === 'string' ? message.content : ''
}
