// ============================================================
// core/logging/Logger.ts —— 日志记录器（Recorder）
//
// 各模块把 LogEvent 经注入的 LogSink 直接发到本模块（组合根
// 装配，无总线中转）。本模块只负责留档与查询（内存，后续可持久化），
// 供评估/进化（telemetry_read）。
// ============================================================

import type { LogEvent } from './events'

/** 日志出口（各模块经此发日志；组合根装配到日志记录器）。 */
export interface LogSink {
  readonly log: (event: LogEvent) => void
}

export interface LogFilter {
  readonly agentId?: string
  readonly type?: string
}

export interface Logger extends LogSink {
  /** 追加一条日志事件。 */
  readonly log: (event: LogEvent) => void
  /** 全部日志。 */
  readonly all: () => readonly LogEvent[]
  /** 按 agentId / 事件 type 过滤查询。 */
  readonly query: (filter?: LogFilter) => readonly LogEvent[]
  /** 清空（测试/重置用）。 */
  readonly clear: () => void
  /** 日志条数。 */
  readonly count: () => number
}

/** 内存日志记录器（后续换 SQLite / 文件，接口已隔离）。 */
export class InMemoryLogger implements Logger {
  private readonly events: LogEvent[] = []

  log(event: LogEvent): void {
    this.events.push(event)
  }

  all(): readonly LogEvent[] {
    return [...this.events]
  }

  query(filter: LogFilter = {}): readonly LogEvent[] {
    return this.events.filter(
      (event) =>
        (filter.agentId === undefined || event.at === undefined || eventInvolvesAgent(event, filter.agentId)) &&
        (filter.type === undefined || event.type === filter.type),
    )
  }

  clear(): void {
    this.events.length = 0
  }

  count(): number {
    return this.events.length
  }
}

/**
 * 事件是否牵涉某 agent（agentId 归属判定的唯一实现）。
 * S5.2 起对外导出：telemetry_query 的可见域过滤与 query() 共用同一映射，
 * 避免"哪些事件算某 agent 的"出现第二套口径。
 */
export function eventInvolvesAgent(event: LogEvent, agentId: string): boolean {
  switch (event.type) {
    case 'tool.invoked':
    case 'gateway.apiRequest':
    case 'context.assembled':
    case 'mailbox.countdown':
    case 'mailbox.delivered':
    case 'kernel.instance.created':
    case 'kernel.status.changed':
    case 'kernel.instance.terminated':
    case 'kernel.instance.interrupted':
    case 'access.asked':
    case 'access.replied':
    case 'context.compacted':
    case 'kernel.class.registered':
    case 'kernel.class.updated':
      return event.agentId === agentId
    case 'kernel.message.sent':
      return event.from === agentId || event.to === agentId
    default:
      return false
  }
}
