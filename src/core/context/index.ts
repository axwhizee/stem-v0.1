// ============================================================
// core/context/index.ts —— 唯一出口
// ============================================================

export type { MailboxState, AgentDelivery, UserDelivery, MailDelivery } from './types'

export type { AssembleInput, AssembleResult, ContextAssembler } from './ContextManager'
export { classicAssemble } from './ContextManager'

export type { TimerHandle, TimerFactory, ReadyContent, MailboxRegistration, MailboxOptions, Mailbox } from './Mailbox'
export { DefaultMailbox } from './Mailbox'

export type { PendingHold, ContextRegistration, ContextManagerOptions, ContextManager } from './ContextManager'
export { DefaultContextManager } from './ContextManager'
