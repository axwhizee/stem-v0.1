// ============================================================
// core/context/index.ts —— 唯一出口
// ============================================================

export type {
  StoredMessage,
  RepositoryState,
  AssembleInput,
  AssembleResult,
  ContextAssembler,
  AgentDelivery,
  UserDelivery,
  MailDelivery,
  PendingHold,
} from './types'
export { classicAssemble } from './types'
export { legalize } from './legalize'

export type { RepositoryOptions, AppendInput, Repository } from './Repository'
export { DefaultRepository, estimateTokens } from './Repository'

export type { RestoredBox, MessageStore } from './store'
export { MemoryMessageStore, messageSeqOf } from './store'
export { PersistedRepository } from './persisted'

export type {
  TimerHandle,
  TimerFactory,
  CourierRegistration,
  CourierOptions,
  CourierState,
  Courier,
} from './Courier'
export { DefaultCourier } from './Courier'

export type { ContextRegistration, ContextManagerOptions, ContextManager } from './ContextManager'
export { DefaultContextManager } from './ContextManager'
