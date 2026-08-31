// ============================================================
// core/context/strategies/index.ts —— 上下文策略子模块唯一出口
// ============================================================

export type {
  ContextSettings,
  ContextStrategyModule,
  StrategyAgentSpec,
  StrategyApi,
} from './types'
export { DEFAULT_CONTEXT_SETTINGS } from './types'

export type { StrategyRegistry } from './registry'
export { DefaultStrategyRegistry } from './registry'

export { classicAssemble, createClassicStrategy, CLASSIC_ROLE, SUMMARIZER_SPEC } from './classic'
export { createNoneStrategy } from './none'

import type { StrategyRegistry } from './registry'
import { DefaultStrategyRegistry } from './registry'
import { createClassicStrategy } from './classic'
import { createNoneStrategy } from './none'
import type { ContextStrategyModule } from './types'

/** 内置策略注册表（classic + none；用户策略经 init 管线 register）。 */
export function createBuiltinStrategyRegistry(extra: readonly ContextStrategyModule[] = []): StrategyRegistry {
  return new DefaultStrategyRegistry([createClassicStrategy(), createNoneStrategy(), ...extra])
}
