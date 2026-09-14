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
} from './types'
export { legalize } from './legalize'
// 信件戳代数（B4：身份全名 + 分钟时刻，打戳/格式断言唯一收口）。
export { formatStampAt, stampSender, hasSenderStamp, SENDER_PREFIX } from './stamp'

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

export type { WaitResult, WaitOptions, Waiter } from './wait'
export { DefaultWaiter, defaultTimer, waitKeys, DEFAULT_SEND_COUNTDOWN_MS } from './wait'

export type { ContextRegistration, ContextManagerOptions, ContextManager } from './ContextManager'
export { DefaultContextManager } from './ContextManager'
