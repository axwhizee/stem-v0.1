// ============================================================
// core/panel/types.ts —— 面板消息（核心 → 面板单向通道）
//
// 所有通向面板的消息统一汇总为 PanelMessage：
//   - letter：agent 回信（原 user0 邮局 delivery 的展示消息，含发送者戳）
//   - permission_request：工具访问确认请求（弹窗模块消费）
//   - notice：普通通知（未来扩展，如 agent 状态变化等）
//
// 面板端（shell/GUI）只需实现一个 consumer 消费统一消息流，
// 内部再分发到展示层 / 弹窗模块。core 与面板解耦，GUI 完全复用。
// ============================================================

import type { ChatMessage } from '../gateway'

/** 面板收到的一封回信（letters 含发送者戳，由展示层解析）。 */
export interface LetterPanelMessage {
  readonly type: 'letter'
  readonly agentId: string
  readonly letters: readonly ChatMessage[]
  readonly at: number
}

/** 工具访问确认请求（弹窗模块消费）。 */
export interface PermissionPanelMessage {
  readonly type: 'permission_request'
  readonly requestId: string
  readonly accessKey: string
  readonly agentId: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly at: number
}

/** 普通通知（未来扩展）。 */
export interface NoticePanelMessage {
  readonly type: 'notice'
  readonly title: string
  readonly body: string
  readonly at: number
}

export type PanelMessage = LetterPanelMessage | PermissionPanelMessage | NoticePanelMessage

/** 面板消息消费者（shell/GUI 注入）。 */
export type PanelConsumer = (message: PanelMessage) => void
