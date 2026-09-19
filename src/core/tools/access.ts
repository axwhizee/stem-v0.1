// ============================================================
// core/tools/access.ts —— 工具访问三态（ToolAccess）纯代数
//
// 权限融合进 tools 后的状态定义与严格度偏序。分层收敛/白名单物化
// 已迁往 lineage/AccessLedger（族谱权限台账，生效权限 = 族谱位置的函数）；
// 本模块只保留被台账与 tools 双方共享的**无状态纯函数**：
//   三态：allow  暴露 + 直接执行
//         deny   不暴露 + 拒绝（链上显式 deny = 不可豁免的铁律）
//         ignore 不暴露（默认隐藏）+ 等同 allow（隐藏的 allow）
//   严格度总序：deny ≺ allow ≺ ignore——按"监督度"排：ignore = 看不见的
//   执行，监督最弱 = 最宽；allow 暴露于清单可审；deny 关闭。
//   继承/更新/物化一律顺链只许向右收缩（藏匿祖先 allow 是扩张，禁止）。
// ============================================================

import type { ToolAccess } from './types'

/**
 * 严格度总序：deny(0) ≺ allow(1) ≺ ignore(2)，值小 = 更严。
 * ignore 最宽（隐藏但可执行、清单不可见）；allow→ignore 即扩张被拒。
 */
const RANK: Readonly<Record<ToolAccess, number>> = { deny: 0, allow: 1, ignore: 2 }

/** 取更严格者（单调收缩总序：任何一环收紧，结果收紧；无同级 tiebreak）。 */
export function restrictAccess(a: ToolAccess, b: ToolAccess): ToolAccess {
  return RANK[a]! <= RANK[b]! ? a : b
}

/** 严格度总序数值（消费方共享：类书写/实例更新收敛校验同一把尺）。 */
export function accessRank(action: ToolAccess): number {
  return RANK[action]!
}

/**
 * 工具清单收敛校验（类书写面 agent_class_update 与实例更新面
 * kernel.updateAgent 共用的单链律）：逐键要求**序不升**
 * （deny ≺ allow ≺ ignore，无同级——藏匿/放宽/翻 deny
 * 皆扩张被拒，曝光/关闭/收敛方向放行）；
 * prev undefined = 比较基线不含该键（继承形/新键）→ 放行——
 * 键即白名单 = 自我限定，实际能力仍由族谱台账物化收敛兜底，扩张不可达。
 */
export function checkToolsConvergence(
  current: Readonly<Record<string, ToolAccess>> | undefined,
  patch: Readonly<Record<string, ToolAccess>>,
): string[] {
  const violations: string[] = []
  for (const [key, next] of Object.entries(patch)) {
    const prev = current?.[key]
    if (prev === undefined || next === prev) continue
    if (accessRank(next) > accessRank(prev)) {
      violations.push(`${key}: ${prev} → ${next}（扩张被拒，只许收敛）`)
    }
  }
  return violations
}

/** 收敛链的层名（失败归因用；kernel 按链步序命名传入——"类收敛被拒"≠"实例收敛被锁"）。 */
export type ConvergenceLayer = '根收敛' | '类收敛' | '策略收敛' | '实例收敛'

/**
 * 收敛链步的形态：
 * - `replace`（缺省）：白名单整表步（类清单/实例清单）——写下即未列键出局；
 * - `raise`：**策略声明清单**专用——只对表内键提升（逐键封顶照旧：出生值
 *   ∧ 当前面显式判定），**不封闭表外键**（raise 步不产生本地封闭）。
 *   声明宽于链上封顶 = 违例（写入面拒绝、物化面静默钳制——与其他步同姿势）。
 */
export type ConvergenceStepMode = 'replace' | 'raise'

/** 未贴层标的收敛链步（kernel accessStepsOf 与族谱台账共用的原料形）。 */
export interface ConvergenceStep {
  readonly list: Readonly<Record<string, ToolAccess>>
  readonly mode?: ConvergenceStepMode
}

/** 收敛链校验违例（带归因的结构，消费方渲染成错误文本）。 */
export interface ConvergenceViolation {
  readonly layer: ConvergenceLayer
  readonly key: string
  readonly wanted: ToolAccess
  /** 封顶值（父面显式判定与出生值取严）。 */
  readonly ceiling: ToolAccess
}

/**
 * 单操作收敛链 = 同一把尺的多次套用（注册表→根清单→类清单→[策略清单]→实例清单）。
 * 逐步折叠校验（不做预合并——两步独立免费获得失败归因）：
 *   每步对当前面的显式判定与出生封顶逐键取严；**取值宽于封顶 = 扩张，记违例**。
 * 纯函数：折叠产物（封顶后档案）与违例分离返回——物化端静默压回（重启稳定），
 * 写入端（实例化/更新）据违例拒绝并报归因。父匿名封闭（fallback）不构成
 * 否决——"缺席 ≠ 否决"由"只折叠 explicit"天然表达。
 */
export function foldConvergenceSteps(
  parentExplicit: Readonly<Record<string, ToolAccess>>,
  caps: Readonly<Record<string, ToolAccess>>,
  steps: readonly (readonly [ConvergenceLayer, Readonly<Record<string, ToolAccess>>, ConvergenceStepMode?])[],
): {
  readonly profile: { explicit: Record<string, ToolAccess>; fallback?: ToolAccess }
  readonly violations: ConvergenceViolation[]
} {
  const violations: ConvergenceViolation[] = []
  let explicit: Record<string, ToolAccess> = { ...parentExplicit }
  for (const [layer, list, mode] of steps) {
    if (mode === 'raise') {
      // 提升步（策略声明清单）：逐键封顶公式与白名单步完全同一把尺，
      // 区别只在不重建白名单（表外键原样穿过）——"只抬不封"。
      const next: Record<string, ToolAccess> = { ...explicit }
      for (const [key, wanted] of Object.entries(list)) {
        const ceiling = restrictAccess(
          caps[key] ?? wanted,
          explicit[key] ?? 'ignore',
        )
        if (accessRank(wanted) > accessRank(ceiling)) {
          violations.push({ layer, key, wanted, ceiling })
        }
        next[key] = restrictAccess(wanted, ceiling)
      }
      explicit = next
      continue
    }
    // 键即白名单：写了表 → 未列键出局（本地封闭 deny——匿名封闭只锁自己，不下传）。
    const next: Record<string, ToolAccess> = {}
    for (const [key, wanted] of Object.entries(list)) {
      const ceiling = restrictAccess(
        caps[key] ?? wanted,
        explicit[key] ?? 'ignore',
      )
      if (accessRank(wanted) > accessRank(ceiling)) {
        violations.push({ layer, key, wanted, ceiling })
      }
      next[key] = restrictAccess(wanted, ceiling)
    }
    explicit = next
  }
  // 任一白名单步写下即本地封闭：未列键一律 deny（raise 步不封闭——
  // 它只补充表内键的判定，能力面的"在场"仍由类/实例清单决定）。
  const hasWhitelistStep = steps.some(([, , mode]) => mode !== 'raise')
  return {
    profile: { explicit, ...(hasWhitelistStep ? { fallback: 'deny' as const } : {}) },
    violations,
  }
}
