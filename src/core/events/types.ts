// ============================================================
// core/events/types.ts —— PilotEvent（外部交互统一事件流）
//
// 收敛 KernelOptions 里散落的 onEvent / onUserDelivery / onPanelMessage
// 三路回调为单一事件流；外部（shell/webui）经 pilot 订阅。
// letter 承载一切「信箱来信」（含 access_request 消息化申请）；
// stream 承载 LLM 流式（text/reasoning/tool/usage/finish）。
// ============================================================

import type { ChatMessage, LLMEvent } from '../gateway'

export type PilotEvent =
  /** LLM 流式事件（agentId + LLMEvent）。 */
  | { readonly type: 'stream'; readonly agentId: string; readonly event: LLMEvent }
  /** 信箱来信（user0 收信/回信；access_request 申请也经此送达）。 */
  | { readonly type: 'letter'; readonly agentId: string; readonly letters: readonly ChatMessage[]; readonly at: number }
  /** 状态变化（thinking/holding/interrupted…）。 */
  | { readonly type: 'status'; readonly agentId: string; readonly from: string; readonly to: string; readonly at: number }
  /** 系统通知（扩展位：init 完成、工具审计等）。 */
  | { readonly type: 'notice'; readonly at: number; readonly message: string }