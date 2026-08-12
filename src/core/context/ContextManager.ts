// ============================================================
// core/context/ContextManager.ts —— 上下文管理器（成分管理 + 拼装 + 就绪信号）
//
// 对外提供「单一上下文接口」：deposit / appendHistory / appendToolRecord /
// registerHold。三种上下文成分（历史 context / 信件 pendingLetters /
// 工具记录 toolRecords）全部由本模块管理，不向外部暴露各自的集合。
//
// 职责划分（context 模块子模块化）：
//   - ContextManager：成分管理 + 拼装（ContextAssembler 子模块）+ 就绪信号；
//   - Mailbox（子模块）：只负责等待「上下文就绪 + 倒计时就绪」→ 发送。
//   - 拼装时机：内容就绪（有信件 / 有等待填充的 tool 结果）时立即拼装出
//     完整上下文快照（只读，不消费信件），交给 Mailbox；Mailbox 发送前
//     触发 beforeSend → ContextManager 把信件并入历史并清空。
//   - user0（assemble=false）：不拼装，直接汇总信件交给 Mailbox 发送。
//
// 存储：内存 JSON 消息列表（后续换 SQLite，接口已隔离）。
// ============================================================

import type { ChatMessage, ToolDefinition } from '../gateway'
import type { ToolRecord } from '../tools'
import type { Mailbox, MailboxRegistration, ReadyContent, TimerFactory } from './Mailbox'
import { DefaultMailbox } from './Mailbox'
import type { MailboxState } from './types'

// ---------- 组装策略（原 ContextAssembler 子模块，合并内化） ----------

export interface AssembleInput {
  readonly systemPrompt: string
  /** 历史上下文（含已并入的信件）。 */
  readonly context: readonly ChatMessage[]
  readonly tools?: readonly ToolDefinition[]
}

export interface AssembleResult {
  readonly system: string
  readonly messages: readonly ChatMessage[]
  readonly tools?: readonly ToolDefinition[]
}

/** 组装策略：把成分拼成完整上下文（可替换，未来 renderPrompt/Compressor 作为策略实现）。 */
export type ContextAssembler = (input: AssembleInput) => AssembleResult

/** 经典组装（默认）：system + context 直接作为 messages。 */
export function classicAssemble(input: AssembleInput): AssembleResult {
  return {
    system: input.systemPrompt,
    messages: [...input.context],
    tools: input.tools,
  }
}

export interface ContextManagerOptions {
  /** 组装策略（缺省经典组装 classicAssemble）。 */
  readonly contextAssembler?: ContextAssembler
  readonly defaultCountdownMs?: number
  readonly timer?: TimerFactory
  /** 可注入邮箱实现（缺省 DefaultMailbox）。 */
  readonly mailbox?: Mailbox
}

/** 实例化时注册（成分信息 + 发送回调）。 */
export interface ContextRegistration {
  readonly agentId: string
  readonly systemPrompt?: string
  readonly sendCountdownMs?: number
  /** false = 用户面板（user0）。 */
  readonly assemble?: boolean
  /** 送信回调（agent → kernel；user → 面板）。 */
  readonly onDelivery: (delivery: import('./types').MailDelivery) => void
  /** 倒计时结束但无信可送时调用（agent → 进入 hold）。 */
  readonly onHold?: (agentId: string) => void
}

/** 挂起等待：context_wait 注册后，等待指定 agent 的 assistant_message 作为 tool 结果填充。 */
export interface PendingHold {
  readonly waitFor: string
  readonly ownerId: string
  readonly toolCallId: string
}

interface InternalBox {
  readonly agentId: string
  systemPrompt: string | undefined
  readonly context: ChatMessage[]
  pendingLetters: ChatMessage[]
  readonly toolRecords: ToolRecord[]
  readonly assemble: boolean
  /** 是否有"等待填充的 tool 结果"待送信。 */
  fillPending: boolean
}

export interface ContextManager {
  readonly register: (registration: ContextRegistration) => Promise<void>
  readonly unregister: (agentId: string) => Promise<void>
  /**
   * 投信（from 为发送者 id，用于 sub 等待分流）。
   * 若 from 命中挂起等待 → 作为 tool 结果填充到等待者上下文（非 user_prompt）。
   */
  readonly deposit: (agentId: string, letter: ChatMessage, from?: string) => Promise<void>
  /** 注册挂起等待：等待 waitFor 的 assistant_message 作为 tool 结果填充到 owner 上下文。 */
  readonly registerHold: (waitFor: string, opts: { ownerId: string; toolCallId: string }) => Promise<void>
  /** 追加历史（runtime 复制 assistant；工具模块注入 tool 结果）。 */
  readonly appendHistory: (agentId: string, message: ChatMessage) => Promise<void>
  /** 工具调用审计记录（工具模块自动发送）。 */
  readonly appendToolRecord: (agentId: string, record: ToolRecord) => Promise<void>
  readonly getState: (agentId: string) => Promise<MailboxState>
}

export class DefaultContextManager implements ContextManager {
  private readonly boxes = new Map<string, InternalBox>()
  private readonly pendingFills = new Map<string, PendingHold>()
  private readonly assemble: ContextAssembler
  private readonly mailbox: Mailbox

  constructor(options: ContextManagerOptions = {}) {
    this.assemble = options.contextAssembler ?? classicAssemble
    this.mailbox =
      options.mailbox ??
      new DefaultMailbox({
        defaultCountdownMs: options.defaultCountdownMs,
        timer: options.timer,
      })
  }

  async register(registration: ContextRegistration): Promise<void> {
    if (this.boxes.has(registration.agentId)) {
      throw { kind: 'mailbox_conflict', agentId: registration.agentId }
    }
    this.boxes.set(registration.agentId, {
      agentId: registration.agentId,
      systemPrompt: registration.systemPrompt,
      context: [],
      pendingLetters: [],
      toolRecords: [],
      assemble: registration.assemble ?? true,
      fillPending: false,
    })
    const mailboxRegistration: MailboxRegistration = {
      agentId: registration.agentId,
      sendCountdownMs: registration.sendCountdownMs,
      onDelivery: registration.onDelivery,
      onHold: registration.onHold,
      // 发送前消费已就绪的信件/填充标记（邮箱不接触上下文成分）。
      beforeSend: (agentId) => this.commit(agentId),
    }
    await this.mailbox.register(mailboxRegistration)
  }

  async unregister(agentId: string): Promise<void> {
    await this.mailbox.unregister(agentId)
    this.boxes.delete(agentId)
  }

  async registerHold(waitFor: string, opts: { ownerId: string; toolCallId: string }): Promise<void> {
    this.pendingFills.set(waitFor, { waitFor, ownerId: opts.ownerId, toolCallId: opts.toolCallId })
  }

  async deposit(agentId: string, letter: ChatMessage, from?: string): Promise<void> {
    // 发送者命中挂起等待 → 该 assistant_message 作为 tool 结果填充，而非信件。
    if (from !== undefined) {
      const pending = this.pendingFills.get(from)
      if (pending) {
        this.pendingFills.delete(from)
        const owner = this.require(pending.ownerId)
        owner.context.push({ role: 'tool', content: letter.content, toolCallId: pending.toolCallId })
        owner.fillPending = true
        this.assembleAndNotify(owner)
        return
      }
    }
    const box = this.require(agentId)
    box.pendingLetters.push(letter)
    this.assembleAndNotify(box)
  }

  async appendHistory(agentId: string, message: ChatMessage): Promise<void> {
    const box = this.require(agentId)
    box.context.push(message)
  }

  async appendToolRecord(agentId: string, record: ToolRecord): Promise<void> {
    const box = this.require(agentId)
    box.toolRecords.push(record)
  }

  async getState(agentId: string): Promise<MailboxState> {
    const box = this.require(agentId)
    const mailboxState = await this.mailbox.getState(agentId)
    return {
      agentId: box.agentId,
      systemPrompt: box.systemPrompt,
      context: [...box.context],
      pendingLetters: [...box.pendingLetters],
      toolRecords: [...box.toolRecords],
      sendCountdownMs: mailboxState.sendCountdownMs,
      assemble: box.assemble,
      coolingDown: mailboxState.coolingDown,
    }
  }

  /** 拼装（agent）或汇总（user）出新内容 → 交给邮箱（就绪信号）。 */
  private assembleAndNotify(box: InternalBox): void {
    let content: ReadyContent
    if (box.assemble) {
      // 只读拼装：快照 = 历史 + 待发送信件（不消费信件，发送后 commit）。
      const result = this.assemble({
        systemPrompt: box.systemPrompt ?? '',
        context: [...box.context, ...box.pendingLetters],
      })
      content = {
        kind: 'context',
        system: result.system,
        messages: result.messages,
        tools: result.tools,
      }
    } else {
      content = { kind: 'letters', letters: [...box.pendingLetters] }
    }
    void this.mailbox.notifyReady(box.agentId, content)
  }

  /** 邮箱发送前调用：把已拼装进快照的信件并入历史并清空（避免重复组装）。 */
  private commit(agentId: string): void {
    const box = this.require(agentId)
    box.context.push(...box.pendingLetters)
    box.pendingLetters = []
    box.fillPending = false
  }

  private require(agentId: string): InternalBox {
    const box = this.boxes.get(agentId)
    if (!box) throw { kind: 'mailbox_not_found', agentId }
    return box
  }
}
