// ============================================================
// core/lineage/LineageTree.ts —— 族谱树（无状态关系查询视图，纯关系）
//
// 关系：InstanceManager（实例存储本体，唯一事实源）持有
//   AgentInstance.parentId（创建时确定、不可变）；LineageTree
//   不存任何关系数据，所有查询基于实例实时推导。
//
// 职责（严格单一，不依赖 tools）：
//   - 关系查询：parent / children / ancestors / descendants / root；
//   - 销毁权判定（isAncestorOf）：仅祖先（含根）可销毁后代。
//
// 权限继承（collectAncestorAccessLayers）在 tools/access 中实现，
// kernel 装配时用 getAncestors + accessLayerOf 组合，本模块不承载。
// user0 是族谱树根（parentId = null）：getAncestors(user0) = []。
// ============================================================

import type { AgentID, AgentInstance } from '../kernel'

export interface LineageTree {
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
  /** 销毁权判定：by ∈ ancestors(target)（根恒 true）。 */
  readonly isAncestorOf: (by: AgentID, target: AgentID) => boolean
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

  constructor(options: LineageTreeOptions) {
    this.getInstance = options.getInstance
    this.getAllInstances = options.getAllInstances
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
}