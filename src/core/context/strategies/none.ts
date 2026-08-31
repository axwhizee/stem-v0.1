// ============================================================
// core/context/strategies/none.ts —— none 策略（零处理基线）
//
// 组装 = 经典直出；无 process、无 actions、无 role——系统工具 agent
// （summarizer 等）与策略扮演 agent 自身的默认策略：不触发任何处理、
// 不再造 agent，天然断绝递归。
// ============================================================

import { classicAssemble } from './classic'
import type { ContextStrategyModule } from './types'

export function createNoneStrategy(): ContextStrategyModule {
  return {
    name: 'none',
    assemble: classicAssemble,
  }
}
