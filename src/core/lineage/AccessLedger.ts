// ============================================================
// core/lineage/AccessLedger.ts —— 权限台账（族谱树能力相的内部实现）
//
// S5.1 起不再是与族谱树并列的独立门面：算法本体原样保留、由
// LineageTree.attach/detach/replay 委托（"台账并入树"，语义矩阵
// 活文档 = AccessLedger.test 随迁）。外部一律经 LineageTree 查询，
// 本文件的具名导出仅供 lineage 内部与台账语义单测使用。
//
// 定位（"权限收敛走族谱"的机制承载）：
//   族谱树兼顾权限清单——agent 的**生效权限是其族谱位置的函数**。
//   本台账是该纯函数的物化：实例注册时两步完成——
//     ① 继承（inherit）：完整继承父 agent 的生效判定；
//     ② 收敛：按**收敛链 steps**（类清单 →[策略清单]→ 实例清单，逐步
//        折叠、不做预合并——两步独立免费失败归因）逐键收缩，且逐键被
//        **注册声明表 caps**（注册表全局封顶）钳制。
//   其他模块（tools 注册表 / ask 总线 / inspect）一律经本接口查询，
//   不得自行拼层——统一接口保证单向收缩不被外部破坏。
//
// 标准形（每节点一个 AccessProfile，注册期物化、运行期只读）：
//   explicit：链上（含自身）所有**显式判定**键的取严结果（祖先值已摊平）；
//   fallback：本地封闭——自身定义了清单（含空 Record）→ 'deny'
//             （键即白名单：未列出 = 不可用）；清单 undefined → 不设限。
//   生效访问 = explicit[key] ?? fallback ?? undefined（undefined → tools 落注册声明）。
//
// 语义四则（活文档 = AccessLedger.test 矩阵）：
//   1. 键即白名单：自身清单已定义（含空 Record）→ 未列出键一律 deny；
//      白名单是**自我限定**——父清单上的 allow 不向定义了自己清单的子女转授权；
//   2. 祖先只供显式判定：链上任一层显式 deny/ask 对全体后代取严生效
//      （deny = 不可豁免的铁律）；祖先的匿名兜底（其自身白名单未列键）
//      是本地封闭，不锁死子女的新申请；
//   3. 不设限（清单 undefined）= 完整继承父档案（含父的本地封闭与摊平判定）
//      ——子能力面永不宽于父。严格度总序 deny ≺ ask ≺ allow ≺ ignore
//      （"同级自决"条款已废：藏匿祖先 allow 判为扩张，物化自动压回）。
//   4. 加法入口 grant（清单形整表替换，受限语义）：免除逐个填 deny 的
//      麻烦，未列出键一律 deny；指定键仍逐键经直接父（摊平）显式判定
//      **封顶取严**——ask 洗不成 allow，deny 铁律是封顶的最严特例；
//      祖先的匿名本地封闭不受 grant 追及（不下传原则一致）。
//
// 依赖：type-only + restrictAccess 纯函数（tools 四态代数），零运行时耦合；
// 反向 tools 不 import 本模块（经 AccessResolver 端口消费，kernel 接线）。
// 持久化：不入库——纯派生态，重启按族谱拓扑序 rebind 重放。
// ============================================================

import type { ConvergenceStep, ToolAccess } from '../tools'
import { foldConvergenceSteps, restrictAccess } from '../tools'

/** 节点权限标准形（物化的收敛结果）。 */
export interface AccessProfile {
  /** 显式判定表（祖先链已摊平 + 自身清单取严）。 */
  readonly explicit: Readonly<Record<string, ToolAccess>>
  /** 本地兜底（'deny' = 自身清单为封闭白名单；缺省 = 不设限，落到工具默认）。 */
  readonly fallback?: ToolAccess
}

/** 绑定模式：减法（继承 + 收敛，默认）/ 加法（系统机制整表替换）。 */
export type AccessBindMode = 'inherit' | 'grant'

export interface AccessBindEntry {
  readonly agentId: string
  readonly parentId: string | null
  /**
   * 收敛链清单步序（同一把尺逐步套用，不做预合并）：
   * [类清单, (策略声明清单 raise), 实例化清单]——undefined 步 = 整表缺席
   * （完整继承接收表面）；全链 undefined = 纯继承父档案。raise 步只抬不封
   * （策略声明清单专属形——能力面在场仍由白名单步决定）。
   */
  readonly steps?: readonly (ConvergenceStep | undefined)[]
  /** 单清单便利形（= steps: [own]；grant 通道与单测语义矩阵用）。 */
  readonly own?: Readonly<Record<string, ToolAccess>>
  /** 注册声明表（注册表供给的访问键宽度封顶，逐键钳制所有步）。 */
  readonly caps?: Readonly<Record<string, ToolAccess>>
  /** 缺省 'inherit'。grant 仅系统机制通道（策略模块/pilot 初始化）使用。 */
  readonly mode?: AccessBindMode
}

export interface AccessLedger {
  /** 注册绑定：按父台账档案 + 自身清单物化标准形。 */
  readonly bind: (entry: AccessBindEntry) => void
  readonly unbind: (agentId: string) => void
  /** 重启重放：任意顺序的绑定集合（内部按族谱拓扑序处理）。 */
  readonly rebind: (entries: readonly AccessBindEntry[]) => void
  readonly has: (agentId: string) => boolean
  /** 统一查询：生效访问（undefined = 无人显式判定且无本地兜底 → 调用方落注册声明）。 */
  readonly effectiveAccess: (agentId: string, key: string) => ToolAccess | undefined
  /** 节点档案（agent_inspect 出示生效权限表用；只读）。 */
  readonly profileOf: (agentId: string) => AccessProfile | undefined
}

export class DefaultAccessLedger implements AccessLedger {
  private readonly profiles = new Map<string, AccessProfile>()

  bind(entry: AccessBindEntry): void {
    this.profiles.set(entry.agentId, computeProfile(entry, this.profiles.get(entry.parentId ?? '')))
  }

  unbind(agentId: string): void {
    this.profiles.delete(agentId)
  }

  rebind(entries: readonly AccessBindEntry[]): void {
    // 拓扑序：父先于子；反复扫描直至无可绑定项（族谱链通常极短）。
    const pending = new Map(entries.map((entry) => [entry.agentId, entry]))
    let progress = true
    while (pending.size > 0 && progress) {
      progress = false
      for (const [id, entry] of [...pending]) {
        if (entry.parentId === null || entry.parentId === id || !pending.has(entry.parentId)) {
          this.bind(entry)
          pending.delete(id)
          progress = true
        }
      }
    }
    // 兜底：环 / 父不在集合内（如祖先已被销毁的残留行）按无父档案绑定。
    for (const entry of pending.values()) this.bind(entry)
  }

  has(agentId: string): boolean {
    return this.profiles.has(agentId)
  }

  effectiveAccess(agentId: string, key: string): ToolAccess | undefined {
    const profile = this.profiles.get(agentId)
    if (!profile) return undefined
    return profile.explicit[key] ?? profile.fallback
  }

  profileOf(agentId: string): AccessProfile | undefined {
    return this.profiles.get(agentId)
  }
}

/** 单节点物化（纯函数）。parentProfile 缺省 = 无父档案（根/父未绑定）。 */
function computeProfile(
  entry: AccessBindEntry,
  parentProfile: AccessProfile | undefined,
): AccessProfile {
  const steps =
    entry.steps !== undefined
      ? entry.steps.filter((step): step is ConvergenceStep => step !== undefined)
      : entry.own !== undefined
        ? [{ list: entry.own }]
        : []

  if (entry.mode === 'grant') {
    // 受限清单形整表替换：未列一律 deny；逐键以直接父摊平显式判定 + 注册声明表
    // 封顶（总序取严——ask 洗不成 allow，deny 铁律即封顶最严特例；父匿名
    // 封闭不在显式表上，不构成否决——与减法"匿名不下传"对称）。
    const explicit: Record<string, ToolAccess> = {}
    for (const [key, action] of Object.entries(steps[0]?.list ?? {})) {
      let capped = action
      const parentCap = parentProfile?.explicit[key]
      if (parentCap !== undefined) capped = restrictAccess(capped, parentCap)
      const birthCap = entry.caps?.[key]
      if (birthCap !== undefined) capped = restrictAccess(capped, birthCap)
      explicit[key] = capped
    }
    return { explicit, fallback: 'deny' }
  }

  if (steps.length === 0) {
    // 整链缺席 = 完整继承父档案（显式判定 + 本地封闭一并照搬）：
    // 子能力面永不宽于父（"权限完整继承自父 agent"的字面表达）。
    return parentProfile ?? { explicit: {} }
  }
  // 纯 raise 链（只有策略声明清单、无白名单步）= 封闭面照搬父档案
  // （raise 只抬键不改"是否本地封闭"——继承形语义与整链缺席一致）。
  const raiseOnly = steps.every((step) => step.mode === 'raise')

  // 减法·键即白名单 + 逐步折叠（代数与 kernel 写入面校验共用
  // foldConvergenceSteps，单一事实源）：白名单步未列键出局（本地封闭 deny）；
  // raise 步（策略声明清单）只抬不封；每键与当前面显式判定 + 注册声明表取严
  // （藏匿/放宽物化压回，收缩单向）。物化端静默钳制（重启幂等稳定）；
  // 拒绝式归因校验在 kernel 写入面。
  const { profile } = foldConvergenceSteps(
    parentProfile?.explicit ?? {},
    entry.caps ?? {},
    steps.map((step) => ['类收敛' as const, step.list, step.mode] as const),
  )
  if (raiseOnly && profile.fallback === undefined && parentProfile?.fallback !== undefined) {
    return { ...profile, fallback: parentProfile.fallback }
  }
  return profile
}
