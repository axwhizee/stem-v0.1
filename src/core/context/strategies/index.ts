// ============================================================
// core/context/strategies/index.ts —— 上下文策略子模块唯一出口
// ============================================================

export type {
  ContextSettings,
  ContextStrategyModule,
  StrategyAgentSpec,
  StrategyApi,
  StrategyInitContext,
  StrategyInitFs,
  StrategyLogEvent,
} from './types'
export { DEFAULT_CONTEXT_SETTINGS } from './types'

export type { StrategyRegistry } from './registry'
export { DefaultStrategyRegistry } from './registry'

export { classicAssemble, createClassicStrategy, CLASSIC_ROLE, SUMMARIZER_SPEC } from './classic'
export { createNoneStrategy } from './none'
export { createCortexStrategy, CORTEX_ROLE, DREAM_WORKER_SPEC, DEFAULT_DREAM_AT } from './cortex/index'
export type { CortexSettings, LtmItem } from './cortex/index'

import type { StrategyRegistry } from './registry'
import { DefaultStrategyRegistry } from './registry'
import { createClassicStrategy } from './classic'
import { createNoneStrategy } from './none'
import { createCortexStrategy } from './cortex/index'
import type { ContextStrategyModule } from './types'

/** 内置策略注册表（classic + none + cortex；用户策略经 init 管线 register）。
 *  cortex 随内置注册但**零副作用**：不激活（须类显式 contextStrategy='cortex'），
 *  init 只建工具与数据目录；writeText 缺位的空间 = 只读降级（warn 一次）。 */
export function createBuiltinStrategyRegistry(extra: readonly ContextStrategyModule[] = []): StrategyRegistry {
  return new DefaultStrategyRegistry([createClassicStrategy(), createNoneStrategy(), createCortexStrategy(), ...extra])
}
