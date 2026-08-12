// ============================================================
// core/logging/events.ts —— 系统日志事件（判别联合，纯数据）
//
// 对齐 docs/architecture.md §4.1 的事件设计 + 用户新增点：
//   - mailbox：不同 id 的倒计时触发状态与发送状态
//   - context：上下文构成 / 成分就绪时间 / 完整上下文留档
//   - gateway：模型调用情况与 token 消耗
//   - tools：tool_call 与 tool_call 返回 + hook 记录
//   - kernel：类/实例/状态/消息等子模块记录
//
// 命名遵循 code-style §3.3（语义过去式），全部带 type 判别字段。
// ============================================================

import type { ChatMessage } from '../gateway'

/** 工具调用（含 hook 相位与结果）。 */
export interface ToolInvoked {
  readonly type: 'tool.invoked'
  readonly at: number
  readonly agentId: string
  readonly tool: string
  readonly args: unknown
  /** hook 相位：called=已触发；success=执行成功；error=执行失败。 */
  readonly phase: 'called' | 'success' | 'error'
  readonly durationMs?: number
  readonly resultText?: string
  readonly errorKind?: string
}

/** 模型调用记录（token 消耗 / 延迟 / 成本）。 */
export interface ApiRequestRecorded {
  readonly type: 'gateway.apiRequest'
  readonly at: number
  readonly agentId: string
  readonly model: string
  readonly provider: string
  readonly promptTokens?: number
  readonly completionTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly latencyMs: number
  readonly cost: number
}

/** 上下文拼装记录（构成 + 成分就绪时间 + 完整上下文留档）。 */
export interface ContextAssembled {
  readonly type: 'context.assembled'
  readonly at: number
  readonly agentId: string
  readonly assemble: boolean
  readonly messageCount: number
  /** 完整上下文留档（拼装快照的 messages）。 */
  readonly messages: readonly ChatMessage[]
  /** 各成分最近就绪时间戳（毫秒）。 */
  readonly readyAt: {
    readonly letters?: number
    readonly history?: number
    readonly tools?: number
  }
}

/** 邮箱倒计时状态变化。 */
export interface MailboxCountdown {
  readonly type: 'mailbox.countdown'
  readonly at: number
  readonly agentId: string
  /** start=开始倒计时；reset=来信重置；fire=倒计时结束触发；hold=无信保持。 */
  readonly action: 'start' | 'reset' | 'fire' | 'hold'
}

/** 邮箱发送记录。 */
export interface MailboxDelivered {
  readonly type: 'mailbox.delivered'
  readonly at: number
  readonly agentId: string
  readonly kind: 'agent' | 'user'
  readonly messageCount: number
}

/** 类注册记录。 */
export interface AgentClassRegistered {
  readonly type: 'kernel.class.registered'
  readonly at: number
  readonly classId: string
}

/** 实例创建记录。 */
export interface AgentInstanceCreated {
  readonly type: 'kernel.instance.created'
  readonly at: number
  readonly agentId: string
  readonly classId: string
  readonly creatorId: string
}

/** 实例状态变化记录。 */
export interface AgentStatusChanged {
  readonly type: 'kernel.status.changed'
  readonly at: number
  readonly agentId: string
  readonly from: string
  readonly to: string
}

/** 实例终止记录。 */
export interface AgentTerminated {
  readonly type: 'kernel.instance.terminated'
  readonly at: number
  readonly agentId: string
}

/** 总线消息记录（发送状态）。 */
export interface AgentMessageSent {
  readonly type: 'kernel.message.sent'
  readonly at: number
  readonly from: string
  readonly to: string
  readonly kind: string
  readonly payloadSize: number
}

/** 权限请求记录（评估动作 + 是否挂起确认）。 */
export interface PermissionAsked {
  readonly type: 'permission.asked'
  readonly at: number
  readonly agentId: string
  readonly permission: string
  readonly action: 'allow' | 'deny' | 'ask'
}

/** 权限回复记录。 */
export interface PermissionReplied {
  readonly type: 'permission.replied'
  readonly at: number
  readonly agentId: string
  readonly permission: string
  readonly requestId: string
  readonly reply: 'once' | 'always' | 'reject'
}

/** 初始化：用户工具注册记录。 */
export interface InitToolRegistered {
  readonly type: 'init.tool.registered'
  readonly at: number
  readonly tool: string
  readonly file: string
}

/** 初始化：用户 agent 类注册记录。 */
export interface InitAgentRegistered {
  readonly type: 'init.agent.registered'
  readonly at: number
  readonly classId: string
  readonly file: string
}

export type LogEvent =
  | ToolInvoked
  | ApiRequestRecorded
  | ContextAssembled
  | MailboxCountdown
  | MailboxDelivered
  | AgentClassRegistered
  | AgentInstanceCreated
  | AgentStatusChanged
  | AgentTerminated
  | AgentMessageSent
  | PermissionAsked
  | PermissionReplied
  | InitToolRegistered
  | InitAgentRegistered
