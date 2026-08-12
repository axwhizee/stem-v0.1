// ============================================================
// core/context/types.ts —— 邮局领域类型（纯 TS，零平台依赖）
//
// 上下文管理器（邮局）按 agentId 分箱持有上下文成分；
// 组装结果通过总线"送信"给收件方（agent 由 kernel 处理，
// user 由面板处理，两者一视同仁）。
// ============================================================

import type { ChatMessage, ToolDefinition } from '../gateway'
import type { ToolRecord } from '../tools'

/** 单个信箱状态（成分状态 + 邮箱状态）。 */
export interface MailboxState {
  readonly agentId: string
  /** 实例化时注册（agent 的 system_prompt）。 */
  readonly systemPrompt?: string
  /** 历史消息（assistant 轮 + tool 结果按来源追加）。 */
  readonly context: readonly ChatMessage[]
  /** 待送信的信件（user_prompt 累积；送信后清空）。 */
  readonly pendingLetters: readonly ChatMessage[]
  /** 工具调用审计（未来深度定制上下文用；经典组装不消费）。 */
  readonly toolRecords: readonly ToolRecord[]
  /** 送信倒计时（模板传入）。 */
  readonly sendCountdownMs: number
  /** false = 用户面板（不做上下文组装，只汇总信件）。 */
  readonly assemble: boolean
  /** 是否处于倒计时（送信合并窗口）中。 */
  readonly coolingDown: boolean
}

/** 送信结果：agent 收到组装后的完整上下文。 */
export interface AgentDelivery {
  readonly kind: 'agent'
  readonly agentId: string
  readonly system: string
  readonly messages: readonly ChatMessage[]
  readonly tools?: readonly ToolDefinition[]
}

/** 送信结果：用户面板收到信件汇总（不组装）。 */
export interface UserDelivery {
  readonly kind: 'user'
  readonly agentId: string
  readonly letters: readonly ChatMessage[]
}

export type MailDelivery = AgentDelivery | UserDelivery
