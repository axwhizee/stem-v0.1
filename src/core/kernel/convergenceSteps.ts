// ============================================================
// core/kernel/convergenceSteps.ts —— 收敛链步原料与写入面校验
//
// 从 Kernel 门面抽出的无状态/窄依赖纯逻辑：步序组装 + 封顶校验。
// ============================================================

import type { ToolAccess } from '../tools'
import { foldConvergenceSteps } from '../tools'
import type { ConvergenceLayer, ConvergenceStep, ConvergenceStepMode } from '../tools'
import type { StrategyRegistry } from '../context'
import type { AccessProfile } from '../lineage'
import type { AgentClassID, AgentID, AgentInstance } from './types'
import type { TemplateRegistry } from './TemplateRegistry'

export type LabeledStep = readonly [
  ConvergenceLayer,
  Readonly<Record<string, ToolAccess>>,
  ConvergenceStepMode | undefined,
]

/** 白名单步原料（undefined = 该层不设限）。 */
export function listStep(list: Readonly<Record<string, ToolAccess>> | undefined): ConvergenceStep | undefined {
  return list === undefined ? undefined : { list }
}

/** 策略声明清单步（raise——只抬不封；策略未声明/解析缺位 = 无此步）。 */
export function strategyStep(
  strategies: StrategyRegistry | undefined,
  contextStrategy: string | undefined,
): ConvergenceStep | undefined {
  if (contextStrategy === undefined) return undefined
  const tools = strategies?.resolve(contextStrategy)?.tools
  return tools !== undefined && Object.keys(tools).length > 0 ? { list: tools, mode: 'raise' } : undefined
}

/** 某 agent 的收敛链步序（类清单 → [策略 raise] → 实例清单；逐步独立）。 */
export function accessStepsOf(
  deps: {
    instances: { getSync: (id: AgentID) => AgentInstance | undefined }
    templates: TemplateRegistry
    strategies?: StrategyRegistry
  },
  agentId: AgentID,
): readonly (ConvergenceStep | undefined)[] {
  const instance = deps.instances.getSync(agentId)
  if (!instance) return []
  const template = deps.templates.getSync(instance.classRef as AgentClassID)
  return [
    listStep(template?.tools),
    strategyStep(deps.strategies, template?.contextStrategy),
    listStep(instance.toolOverride),
  ]
}

/**
 * 写入面拒绝式校验：逐步折叠，取值宽于封顶 = 扩张 → 违例带层归因。
 * 整表缺席的步跳过（= 该层不设限）。
 */
export function validateAccessSteps(
  parent: AccessProfile | undefined,
  birthCaps: Readonly<Record<string, ToolAccess>>,
  steps: readonly LabeledStep[],
): string[] {
  const { violations } = foldConvergenceSteps(parent?.explicit ?? {}, birthCaps, steps)
  return violations.map(
    (v) => `${v.layer}被拒 ${v.key}: ${v.wanted}（封顶 ${v.ceiling}——扩张被拒，只许沿 ignore→allow→ask→deny 收紧）`,
  )
}

/** 收敛链步序 → 带层标签三元组（两步 = 类/实例；三步含策略层）。 */
export function labeledSteps(
  steps: readonly (ConvergenceStep | undefined)[],
  first: ConvergenceLayer,
): LabeledStep[] {
  const labels: ConvergenceLayer[] = steps.length >= 3 ? [first, '策略收敛', '实例收敛'] : [first, '实例收敛']
  return steps
    .map((step, i) => (step === undefined ? undefined : ([labels[i] ?? '实例收敛', step.list, step.mode] as const)))
    .filter((p): p is LabeledStep => p !== undefined)
}
