// ============================================================
// core/lineage/AccessLedger.ts —— 权限台账（族谱权限收敛的唯一接口）
//
// 定位（"权限收敛走族谱"的机制承载）：
//   族谱树兼顾权限清单——agent 的**生效权限是其族谱位置的函数**。
//   本台账是该纯函数的物化：实例注册时两步完成——
//     ① 继承（inherit）：完整继承父 agent 的生效判定；
//     ② 收敛（converge/grant）：按该 agent 的自身清单（类 tools +
//        实例 toolOverride 合并）做单向收缩。
//   其他模块（tools 注册表 / ask 总线 / inspect）一律经本接口查询，
//   不得自行拼层——统一接口保证单向收缩不被外部破坏。
//
// 标准形（每节点一个 AccessProfile，注册期物化、运行期只读）：
//   explicit：链上（含自身）所有**显式判定**键的取严结果（祖先值已摊平）；
//   fallback：本地封闭——自身定义了清单（含空 Record）→ 'deny'
//             （键即白名单：未列出 = 不可用）；清单 undefined → 不设限。
//   生效访问 = explicit[key] ?? fallback ?? undefined（undefined → tools 落默认）。
//
// 语义四则（活文档 = AccessLedger.test 矩阵）：
//   1. 键即白名单：自身清单已定义（含空 Record）→ 未列出键一律 deny；
//      白名单是**自我限定**——父清单上的 allow 不向定义了自己清单的子女转授权；
//   2. 祖先只供显式判定：链上任一层显式 deny/ask 对全体后代取严生效
//      （deny = 不可豁免的铁律）；祖先的匿名兜底（其自身白名单未列键）
//      是本地封闭，不锁死子女的新申请；
//   3. 不设限（清单 undefined）= 完整继承父档案（含父的本地封闭与摊平判定）
//      ——子能力面永不宽于父；同级（allow/ignore）自身值优先（可见性自决）；
//   4. 加法入口 grant（系统机制专用特权，agent_instantiate 工具路径不可达）：
//      整表替换——免除逐个填 deny 的麻烦，未列出键一律 deny；
//      但指定键仍经祖先链**显式 deny** 鉴权（deny 是不可豁免的铁律）。
//
// 依赖：type-only + restrictAccess 纯函数（tools 四态代数），零运行时耦合；
// 反向 tools 不 import 本模块（经 AccessResolver 端口消费，kernel 接线）。
// 持久化：不入库——纯派生态，重启按族谱拓扑序 rebind 重放。
// ============================================================

import type { ToolAccess } from '../tools'
import { restrictAccess } from '../tools'

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
  /** 该 agent 的自身清单（类 tools 与实例 toolOverride 的合并；undefined = 不设限）。 */
  readonly own?: Readonly<Record<string, ToolAccess>>
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
  /** 统一查询：生效访问（undefined = 无人显式判定且无本地兜底 → 调用方落默认值）。 */
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
  if (entry.mode === 'grant') {
    // 加法：整表替换（覆盖祖先的 allow/ask/匿名封闭），未列出键一律 deny；
    // 但指定键仍受祖先链显式 deny 铁律约束（deny 不可被 grant 豁免）。
    const explicit: Record<string, ToolAccess> = {}
    for (const [key, action] of Object.entries(entry.own ?? {})) {
      explicit[key] = parentProfile?.explicit[key] === 'deny' ? 'deny' : action
    }
    return { explicit, fallback: 'deny' }
  }

  if (entry.own === undefined) {
    // 不设限 = 完整继承父档案（显式判定 + 本地封闭一并照搬）：
    // 子能力面永不宽于父（"权限完整继承自父 agent"的字面表达）。
    return parentProfile ?? { explicit: {} }
  }

  // 减法·键即白名单：自身键逐一与父档案显式判定取严（deny/ask 锁子孙）；
  // 父的 allow 不向定义了自己清单的子女转授权（白名单自我限定），
  // 父的匿名封闭也只锁父自己（子女显式新申请不受阻）。
  const explicit: Record<string, ToolAccess> = {}
  for (const [key, action] of Object.entries(entry.own)) {
    const inherited = parentProfile?.explicit[key]
    // restrictAccess(a, b)：同级取 a —— 传 (自身, 祖先) 使自身值优先
    //（allow/ignore 同级：可见性由本 agent 自决）。
    explicit[key] = inherited === undefined ? action : restrictAccess(action, inherited)
  }
  return { explicit, fallback: 'deny' }
}
