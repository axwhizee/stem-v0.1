// ============================================================
// core/logging/index.ts —— 唯一出口
// ============================================================

export type {
  LogEvent,
  KernelOrphanError,
  ToolInvoked,
  ApiRequestRecorded,
  ContextAssembled,
  MailboxCountdown,
  MailboxDelivered,
  AgentClassRegistered,
  AgentClassUpdated,
  AgentInstanceCreated,
  AgentStatusChanged,
  AgentTerminated,
  AgentInterrupted,
  AgentMessageSent,
} from './events'

export type { LogSink, LogFilter, Logger } from './Logger'
export { InMemoryLogger, eventInvolvesAgent } from './Logger'
export { forget } from './forget'
