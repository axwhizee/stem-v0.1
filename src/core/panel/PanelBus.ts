// ============================================================
// core/panel/PanelBus.ts —— 面板消息总线（核心 → 面板单向）
//
// 所有通向面板的消息（回信 / 权限请求 / 通知）统一汇总到一条流，
// 由面板端注入的 consumer 消费（内部再分发到展示层 / 弹窗模块）。
// core 只发消息，不关心面板 UI 形态 —— GUI 可完全复用。
// ============================================================

import type { PanelConsumer, PanelMessage } from './types'

export interface PanelBusOptions {
  /** 面板消息消费者（shell/GUI 注入）。 */
  readonly consumer?: PanelConsumer
}

export interface PanelBus {
  /** 设置面板消费者（组合根装配时注入）。 */
  readonly setConsumer: (consumer: PanelConsumer) => void
  /** 发布一条面板消息。 */
  readonly post: (message: PanelMessage) => void
}

export class DefaultPanelBus implements PanelBus {
  private consumer: PanelConsumer | undefined

  constructor(options: PanelBusOptions = {}) {
    this.consumer = options.consumer
  }

  setConsumer(consumer: PanelConsumer): void {
    this.consumer = consumer
  }

  post(message: PanelMessage): void {
    this.consumer?.(message)
  }
}
