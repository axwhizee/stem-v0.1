// ============================================================
// core/logging/Logger.ts —— 日志记录器（Recorder）
//
// 作为 MessageBus 的「log 订阅者」：各模块把 LogEvent 经消息总线
// 发送到本模块（组合根把 bus 的 log 路由接到这里）。本模块只负责
// 留档与查询（内存，后续可持久化），供评估/进化（telemetry_read）。
// ============================================================

import type { LogEvent } from './events'

/** 日志出口（各模块经此发日志；组合根接到 bus 的 log 路由）。 */
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
        (filter.agentId === undefined || event.at === undefined || eventMatchesAgent(event, filter.agentId)) &&
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

function eventMatchesAgent(event: LogEvent, agentId: string): boolean {
  switch (event.type) {
    case 'tool.invoked':
    case 'gateway.apiRequest':
    case 'context.assembled':
    case 'mailbox.countdown':
    case 'mailbox.delivered':
    case 'kernel.instance.created':
    case 'kernel.status.changed':
    case 'kernel.instance.terminated':
    case 'permission.asked':
    case 'permission.replied':
      return event.agentId === agentId
    case 'kernel.message.sent':
      return event.from === agentId || event.to === agentId
    default:
      return false
  }
}
