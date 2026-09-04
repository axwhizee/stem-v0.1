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
export { legalize } from './legalize'

// 上下文策略子模块（契约 + 注册表 + 内置 classic/none）。
export type {
  ContextSettings,
  ContextStrategyModule,
  StrategyAgentSpec,
  StrategyApi,
  StrategyInitContext,
  StrategyInitFs,
  StrategyLogEvent,
  StrategyRegistry,
} from './strategies'
export {
  DEFAULT_CONTEXT_SETTINGS,
  DefaultStrategyRegistry,
  createBuiltinStrategyRegistry,
  createClassicStrategy,
  createNoneStrategy,
  createCortexStrategy,
  classicAssemble,
} from './strategies'

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
