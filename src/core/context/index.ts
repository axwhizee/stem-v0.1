// ============================================================
// core/context/index.ts —— 唯一出口
// ============================================================

export type { MailboxState, AgentDelivery, UserDelivery, MailDelivery } from './types'

export type { AssembleInput, AssembleResult, ContextAssembler } from './ContextAssembler'
export { ClassicContextAssembler } from './ContextAssembler'

export type { TimerHandle, TimerFactory, MailboxRegistration, PendingHold, ContextManagerOptions, ContextManager } from './ContextManager'
export { DefaultContextManager } from './ContextManager'
