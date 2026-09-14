// ============================================================
// core/context/types.ts —— 上下文领域类型（纯 TS，零平台依赖）
//
// 新架构（重建邮局：仓库 / 管理员 / 快递员）：
//   - 仓库（Repository）：存储所有 agent 的完整上下文消息记录（唯一本体）；
//   - 管理员（ContextManager）：处理/累积/打戳/组装（classic/hybrid 模式）；
//   - 快递员（Courier）：按 agentId 维护倒计时，从仓库取有效消息发送。
// ============================================================

import type { ChatMessage, ToolDefinition } from '../gateway'
import type { ToolRecord } from '../tools'

/** 仓库中的单条消息记录（上下文本体的最小单元）。 */
export interface StoredMessage {
  readonly id: string
  /** 所属 agent id。 */
  readonly agentId: string
  /** 完整消息（system/user/assistant/tool）。 */
  readonly message: ChatMessage
  /** 入库时间戳（毫秒）。 */
  readonly at: number
  /** token 估算（字符/4 占位；真实记账后续接入）。 */
  readonly tokens: number
  /** 是否有效：false = 已被管理员标记（压缩/淘汰），发送时跳过。 */
  readonly valid: boolean
  /** 发送者 id（仅 user 消息；assistant/tool 无）。 */
  readonly from?: string
  /**
   * 描述性标签（可选）：标记非原生消息（由上下文管理策略生成的合成消息，
   * 如 summary / impression / meta）。**strategy 不作为 tag 的一部分**——
   * 每个 agent 的上下文策略在开辟上下文空间时已确定（上下文属性），
   * 组装器按 agent 的策略解释 tag。
   */
  readonly tag?: string
  /** 轮序号（复用实例 turnCount 语义：一个 user 消息 + 其引发的多轮工具调用 = 一轮）。 */
  readonly turn: number
  /** 轮内序号（该轮内 system/user/assistant/tool 的 0-based 顺序）。 */
  readonly indexInTurn: number
}

/** 仓库状态（供展示/调试/测试）。 */
export interface RepositoryState {
  readonly agentId: string
  /** 全部记录（含无效）。 */
  readonly messages: readonly StoredMessage[]
  /** 有效消息（按顺序，供组装）。 */
  readonly validMessages: readonly StoredMessage[]
  /** 已注册的 agent id 集合。 */
  readonly registered: readonly string[]
}

/** 组装输入：从仓库有效记录提取。 */
export interface AssembleInput {
  readonly agentId: string
  /** 仓库有效消息（含开头的 system message）。 */
  readonly messages: readonly StoredMessage[]
  readonly tools?: readonly ToolDefinition[]
}

/** 组装结果（快递员发送用）。 */
export interface AssembleResult {
  readonly system: string
  readonly messages: readonly ChatMessage[]
  /** 本次发送的仓库消息 id 列表（含 system，供 runtime/未来记账）。 */
  readonly messageIds: readonly string[]
  readonly tools?: readonly ToolDefinition[]
}

/**
 * 组装策略：把有效记录组装成完整上下文。
 * 具体策略实现已迁往 `strategies/` 子目录（classic/none + 注册表分发，
 * 每个 agent 按开辟上下文空间时确定的策略组装——不再全局单一装配器）。
 */
export type ContextAssembler = (input: AssembleInput) => AssembleResult

/** 送信结果：agent 收到组装后的完整上下文。 */
export interface AgentDelivery {
  readonly kind: 'agent'
  readonly agentId: string
  readonly system: string
  readonly messages: readonly ChatMessage[]
  /** 本次发送涉及的仓库消息 id（供 runtime/未来 token 记账）。 */
  readonly messageIds: readonly string[]
  readonly tools?: readonly ToolDefinition[]
}

/** 送信结果：用户面板收到信件汇总（不组装）。 */
export interface UserDelivery {
  readonly kind: 'user'
  readonly agentId: string
  readonly letters: readonly ChatMessage[]
}

export type MailDelivery = AgentDelivery | UserDelivery

export type { ToolRecord }
