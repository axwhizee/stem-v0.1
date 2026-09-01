// ============================================================
// core/lineage/LineageTree.ts —— 族谱树（实例层派生事实的唯一门面）
//
// S5.1 重构（方案 = docs/evolution-plan.md §3）：拓扑 + 能力 + 可见域
// 三相合一。"实例树"仅为概念别名，命名保留族谱树。
//
// 关系（拓扑相，原有）：InstanceManager 持有 AgentInstance.parentId
//   （创建时确定、不可变，唯一事实源）；本树不存关系数据，
//   所有拓扑查询基于实例实时推导。
// 能力（能力相，原 AccessLedger 独立并列 → 并入为内部组成）：
//   生效权限 = 族谱位置的函数，注册期由 attach 物化（继承→收敛两步），
//   运行期只读查询（effectiveAccess/profileOf）。台账算法本体不重写，
//   组合 AccessLedger.ts 内部实现（语义矩阵活文档随迁）。
// 可见域（canReach）：自身 ∪ 祖先代查——一切跨 agent 操作面
//   （context_* 工具、telemetry_query、销毁/中断权）统一收敛到此谓词，
//   消除各工具内重复的族谱判定散点。
//
// 红线（方案 D2/D3）：
//   - 派生态不入库：attach/replay 可完整重建（重启按拓扑序重放）；
//   - 不承载运行时/时间轴状态（status/turnCount/送信 = Runtime/kernel）；
//   - 零类层依赖：自身清单（own）由 kernel 算好传入，本模块不读模板。
//
// user0 是族谱根（parentId = null）：getAncestors(user0) = []。
// ============================================================

import type { AgentID, AgentInstance } from '../kernel'
import type { ToolAccess } from '../tools'
import type { AccessBindEntry, AccessLedger, AccessProfile } from './AccessLedger'
import { DefaultAccessLedger } from './AccessLedger'

export interface LineageTree {
  // ---------- 拓扑（无状态实时推导） ----------
  /** 直接父（根为 null）。 */
  readonly getParent: (agentId: AgentID) => AgentID | null
  /** 直接子（扫描实例，O(n)）。 */
  readonly getChildren: (agentId: AgentID) => readonly AgentID[]
  /** 祖先链 [父 → … → 根]（不含自身）。 */
  readonly getAncestors: (agentId: AgentID) => readonly AgentID[]
  /** 后代集合（BFS 子树，含全部层级）。 */
  readonly getDescendants: (agentId: AgentID) => readonly AgentID[]
  /** 族谱根（祖先链末端；自身即根时返回自身）。 */
  readonly getRoot: (agentId: AgentID) => AgentID
  /** 严格祖先判定（不含自身）。 */
  readonly isAncestorOf: (by: AgentID, target: AgentID) => boolean

  // ---------- 能力（台账物化；注册期写入、运行期只读） ----------
  /** 注册绑定：按父档案 + 自身清单物化（kernel 实例化/根注册调用）。 */
  readonly attach: (entry: AccessBindEntry) => void
  /** 注销（销毁级联时逐节点摘除）。 */
  readonly detach: (agentId: string) => void
  /** 重启重放：任意顺序绑定集合（内部按族谱拓扑序处理，纯派生态不入库）。 */
  readonly replay: (entries: readonly AccessBindEntry[]) => void
  /** 是否已绑定。 */
  readonly has: (agentId: string) => boolean
  /** 生效访问（undefined = 无人显式判定且无本地兜底 → 调用方落默认值）。 */
  readonly effectiveAccess: (agentId: string, key: string) => ToolAccess | undefined
  /** 节点权限档案（agent_inspect 出示用；只读）。 */
  readonly profileOf: (agentId: string) => AccessProfile | undefined

  // ---------- 可见域（一切跨 agent 操作面的统一树谓词） ----------
  /** viewer 可触及 target ⟺ 自身 ∨ viewer 是 target 的祖先（根天然全视）。 */
  readonly canReach: (viewer: AgentID, target: AgentID) => boolean
}

export interface LineageTreeOptions {
  /** 实例查询器（注入 InstanceManager.get）。 */
  readonly getInstance: (agentId: AgentID) => AgentInstance | undefined
  /** 枚举全部实例（注入 InstanceManager 的快照，供 children/descendants）。 */
  readonly getAllInstances: () => readonly AgentInstance[]
}

export class DefaultLineageTree implements LineageTree {
  private readonly getInstance: (agentId: AgentID) => AgentInstance | undefined
  private readonly getAllInstances: () => readonly AgentInstance[]
  /** 能力相内部实现（AccessLedger 算法不重写，门面化组合）。 */
  private readonly ledger: AccessLedger

  constructor(options: LineageTreeOptions) {
    this.getInstance = options.getInstance
    this.getAllInstances = options.getAllInstances
    this.ledger = new DefaultAccessLedger()
  }

  getParent(agentId: AgentID): AgentID | null {
    return this.getInstance(agentId)?.parentId ?? null
  }

  getChildren(agentId: AgentID): readonly AgentID[] {
    const result: AgentID[] = []
    for (const instance of this.getAllInstances()) {
      if (instance.parentId === agentId) result.push(instance.id)
    }
    return result
  }

  getAncestors(agentId: AgentID): readonly AgentID[] {
    const chain: AgentID[] = []
    let current = this.getInstance(agentId)
    while (current?.parentId != null) {
      chain.push(current.parentId)
      current = this.getInstance(current.parentId)
    }
    return chain
  }

  getDescendants(agentId: AgentID): readonly AgentID[] {
    const result: AgentID[] = []
    const queue: AgentID[] = [agentId]
    const seen = new Set<AgentID>([agentId])
    while (queue.length > 0) {
      const current = queue.shift()
      if (current === undefined) continue
      for (const child of this.getChildren(current)) {
        if (seen.has(child)) continue
        seen.add(child)
        result.push(child)
        queue.push(child)
      }
    }
    return result
  }

  getRoot(agentId: AgentID): AgentID {
    const ancestors = this.getAncestors(agentId)
    return ancestors.length > 0 ? (ancestors[ancestors.length - 1] as AgentID) : agentId
  }

  isAncestorOf(by: AgentID, target: AgentID): boolean {
    if (by === target) return false
    for (const ancestor of this.getAncestors(target)) {
      if (ancestor === by) return true
    }
    return false
  }

  // ---------- 能力相（委托台账） ----------

  attach(entry: AccessBindEntry): void {
    this.ledger.bind(entry)
  }

  detach(agentId: string): void {
    this.ledger.unbind(agentId)
  }

  replay(entries: readonly AccessBindEntry[]): void {
    this.ledger.rebind(entries)
  }

  has(agentId: string): boolean {
    return this.ledger.has(agentId)
  }

  effectiveAccess(agentId: string, key: string): ToolAccess | undefined {
    return this.ledger.effectiveAccess(agentId, key)
  }

  profileOf(agentId: string): AccessProfile | undefined {
    return this.ledger.profileOf(agentId)
  }

  // ---------- 可见域 ----------

  canReach(viewer: AgentID, target: AgentID): boolean {
    return viewer === target || this.isAncestorOf(viewer, target)
  }
}
