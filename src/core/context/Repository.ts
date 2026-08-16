// ============================================================
// core/context/Repository.ts —— 仓库子模块（上下文本体的唯一存储）
//
// 职责（严格单一，逻辑判断交给管理员）：
//   - 存储所有 agent 运行时产生的完整上下文消息记录（唯一本体）；
//   - 任何消息（user/assistant/tool/system）都先入库，记录
//     完整 message / agentId / 时间戳 / token 估算 / 有效性 / 发送者；
//   - 收到新消息后触发 onChange(agentId)（管理员处理入口）。
//
// 未来：底层换数据库（SQLite 等），本接口已隔离。
// ============================================================

import type { LogEvent } from '../logging'
import type { ChatMessage } from '../gateway'
import type { RepositoryState, StoredMessage } from './types'

/** 消息变更通知（组合根装配时设置 onChange）。 */
export interface RepositoryOptions {
  /** 日志出口（组合根注入 → core/logging）。 */
  readonly onLog?: (event: LogEvent) => void
}

/** 追加消息入参。 */
export interface AppendInput {
  readonly message: ChatMessage
  /** 发送者 id（仅 user 消息）。 */
  readonly from?: string
  /** token 估算（缺省按字符/4）。 */
  readonly tokens?: number
  /**
   * 描述性标签（可选）：标记非原生消息（summary/impression/meta 等）。
   * 语义由该 agent 的上下文策略解释（strategy 是上下文属性，不在 tag 中）。
   */
  readonly tag?: string
}

export interface Repository {
  /** 有新消息入库时的处理入口（组合根注入 = 管理员 handleChange）。 */
  onChange: (agentId: string) => void
  /** 实例化时开辟记录（systemPrompt 作为首条 system message）。 */
  readonly register: (agentId: string, systemPrompt?: string) => Promise<void>
  readonly unregister: (agentId: string) => Promise<void>
  /** 追加消息入库（触发 onChange）。 */
  readonly append: (agentId: string, input: AppendInput) => Promise<StoredMessage>
  /** 全部记录（含无效）。 */
  readonly list: (agentId: string) => readonly StoredMessage[]
  /** 有效消息（按顺序）。 */
  readonly listValid: (agentId: string) => readonly StoredMessage[]
  /** 管理员标记消息无效（压缩/淘汰）。 */
  readonly markInvalid: (agentId: string, ids: readonly string[]) => Promise<void>
  /** 管理员打戳时重写某条消息（如 user 消息加发送者戳）。 */
  readonly updateMessage: (agentId: string, id: string, message: ChatMessage) => Promise<void>
  readonly getState: (agentId: string) => RepositoryState
  readonly listRegistered: () => readonly string[]
  /** 判断 agent 是否已注册。 */
  readonly has: (agentId: string) => boolean
}

interface InternalBox {
  readonly agentId: string
  readonly messages: StoredMessage[]
  /** 下一轮序号（从 1 开始；system 为 0）。 */
  nextTurn: number
  /** 下一轮内序号。 */
  nextIndexInTurn: number
}

export class DefaultRepository implements Repository {
  private readonly boxes = new Map<string, InternalBox>()
  private counter = 0
  private readonly onLog?: (event: LogEvent) => void
  /** 消息变更处理入口（组合根装配时注入管理员 handleChange）。 */
  onChange: (agentId: string) => void = () => {}

  constructor(options: RepositoryOptions = {}) {
    this.onLog = options.onLog
  }

  async register(agentId: string, systemPrompt?: string): Promise<void> {
    if (this.boxes.has(agentId)) {
      throw { kind: 'repository_conflict', agentId }
    }
    const box: InternalBox = { agentId, messages: [], nextTurn: 0, nextIndexInTurn: 0 }
    this.boxes.set(agentId, box)
    if (systemPrompt !== undefined && systemPrompt !== '') {
      // system 消息：第 0 轮第 0 条；之后第一个 user 为第 1 轮。
      const stored: StoredMessage = {
        id: `m-${++this.counter}`,
        agentId,
        message: { role: 'system', content: systemPrompt },
        at: Date.now(),
        tokens: estimateTokens({ role: 'system', content: systemPrompt }),
        valid: true,
        turn: 0,
        indexInTurn: 0,
      }
      box.messages.push(stored)
      box.nextTurn = 1
    }
  }

  async unregister(agentId: string): Promise<void> {
    this.boxes.delete(agentId)
  }

  async append(agentId: string, input: AppendInput): Promise<StoredMessage> {
    const box = this.require(agentId)
    const stored = this.push(box, input)
    this.onChange(agentId)
    return stored
  }

  list(agentId: string): readonly StoredMessage[] {
    return [...this.require(agentId).messages]
  }

  listValid(agentId: string): readonly StoredMessage[] {
    return this.require(agentId).messages.filter((m) => m.valid)
  }

  async markInvalid(agentId: string, ids: readonly string[]): Promise<void> {
    const box = this.require(agentId)
    const target = new Set(ids)
    for (const stored of box.messages) {
      if (target.has(stored.id)) {
        box.messages[box.messages.indexOf(stored)] = { ...stored, valid: false }
      }
    }
  }

  async updateMessage(agentId: string, id: string, message: ChatMessage): Promise<void> {
    const box = this.require(agentId)
    const idx = box.messages.findIndex((m) => m.id === id)
    if (idx < 0) return
    box.messages[idx] = { ...box.messages[idx]!, message }
  }

  getState(agentId: string): RepositoryState {
    const box = this.require(agentId)
    const messages = [...box.messages]
    return {
      agentId: box.agentId,
      messages,
      validMessages: messages.filter((m) => m.valid),
      registered: [...this.boxes.keys()],
    }
  }

  listRegistered(): readonly string[] {
    return [...this.boxes.keys()]
  }

  has(agentId: string): boolean {
    return this.boxes.has(agentId)
  }

  /** 内部入库（不触发 onChange）。 */
  private push(box: InternalBox, input: AppendInput): StoredMessage {
    // 轮次：user 消息开启新轮（turn = nextTurn，轮内序号归 0，nextTurn 递增）；
    // 其余消息同一轮内继续（turn = nextTurn - 1，indexInTurn 递增）。
    const isNewTurn = input.message.role === 'user'
    const turn = isNewTurn ? box.nextTurn : box.nextTurn - 1
    const indexInTurn = isNewTurn ? 0 : box.nextIndexInTurn
    if (isNewTurn) {
      box.nextTurn += 1
      box.nextIndexInTurn = 1
    } else {
      box.nextIndexInTurn += 1
    }
    const stored: StoredMessage = {
      id: `m-${++this.counter}`,
      agentId: box.agentId,
      message: input.message,
      at: Date.now(),
      tokens: input.tokens ?? estimateTokens(input.message),
      valid: true,
      ...(input.from !== undefined ? { from: input.from } : {}),
      ...(input.tag !== undefined ? { tag: input.tag } : {}),
      turn,
      indexInTurn,
    }
    box.messages.push(stored)
    return stored
  }

  private require(agentId: string): InternalBox {
    const box = this.boxes.get(agentId)
    if (!box) throw { kind: 'repository_not_found', agentId }
    return box
  }
}

/** token 估算（字符/4 近似；真实记账后续接入）。 */
export function estimateTokens(message: ChatMessage): number {
  const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
  return Math.ceil(text.length / 4)
}
