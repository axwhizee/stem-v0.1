// ============================================================
// core/events/EventHub.ts —— 事件中心（多订阅者，纯逻辑）
//
// PilotEvent 的唯一发布源：kernel 内部 emit，外部经 pilot.subscribe
// 订阅。多订阅者（cli 与 webui 可同时订阅）；新订阅者拿不到历史事件，
// 初始视图靠直接查询模块（list/inspect/overview）。
// ============================================================

import type { PilotEvent } from './types'

export interface EventHub {
  /** 订阅事件流；返回退订函数。 */
  readonly subscribe: (listener: (event: PilotEvent) => void) => () => void
  /** 发布事件（同步分发到所有订阅者）。 */
  readonly emit: (event: PilotEvent) => void
}

export class DefaultEventHub implements EventHub {
  private readonly listeners = new Set<(event: PilotEvent) => void>()

  subscribe(listener: (event: PilotEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(event: PilotEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}