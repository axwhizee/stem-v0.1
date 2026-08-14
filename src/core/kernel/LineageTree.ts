// ============================================================
// core/kernel/LineageTree.ts —— 族谱树（无状态关系查询视图）
//
// 关系：InstanceManager（实例存储本体，唯一事实源）持有
//   AgentInstance.parentId（创建时确定、不可变）；LineageTree
//   不存任何关系数据，所有查询基于实例实时推导。
//
// 职责：
//   - 关系查询：parent / children / ancestors / descendants；
//   - 销毁权判定（isAncestorOf）：仅祖先（含 user0 根）可销毁后代；
//   - 权限继承（resolveAccessLayers）：父 → … → user0 逐层收集
//     ToolAccessRules，供 AccessManager 分层取最严格（单向收缩）。
//
// user0 是族谱树根（parentId = null）：getAncestors(user0) = []。
// ============================================================

import type { ToolAccessRules } from '../tools'
import type { AgentID, AgentInstance } from './types'

export interface LineageTree {
  /** 直接父（user0 或游离根为 null）。 */
  readonly getParent: (agentId: AgentID) => AgentID | null
  /** 直接子（扫描实例，O(n)）。 */
  readonly getChildren: (agentId: AgentID) => readonly AgentID[]
  /** 祖先链 [父 → … → user0]（不含自身）。 */
  readonly getAncestors: (agentId: AgentID) => readonly AgentID[]
  /** 后代集合（BFS 子树，含全部层级）。 */
  readonly getDescendants: (agentId: AgentID) => readonly AgentID[]
  /** 销毁权判定：by ∈ ancestors(target)（user0 根恒 true）。 */
  readonly isAncestorOf: (by: AgentID, target: AgentID) => boolean
  /** 权限继承：祖先链逐层收集访问规则（父 → … → user0；越靠前越局部）。 */
  readonly resolveAccessLayers: (agentId: AgentID) => readonly ToolAccessRules[]
}

export interface LineageTreeOptions {
  /** 实例查询器（注入 InstanceManager.get）。 */
  readonly getInstance: (agentId: AgentID) => AgentInstance | undefined
  /** 枚举全部实例（注入 InstanceManager 的快照，供 children/descendants）。 */
  readonly getAllInstances: () => readonly AgentInstance[]
  /** 由实例提取其访问层（缺省 = 实例 AgentClass.toolAccess 经 kernel 装配）。 */
  readonly accessLayerOf?: (instance: AgentInstance) => ToolAccessRules | undefined
}

export class DefaultLineageTree implements LineageTree {
  private readonly getInstance: (agentId: AgentID) => AgentInstance | undefined
  private readonly getAllInstances: () => readonly AgentInstance[]
  private readonly accessLayerOf?: (instance: AgentInstance) => ToolAccessRules | undefined

  constructor(options: LineageTreeOptions) {
    this.getInstance = options.getInstance
    this.getAllInstances = options.getAllInstances
    this.accessLayerOf = options.accessLayerOf
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

  isAncestorOf(by: AgentID, target: AgentID): boolean {
    if (by === target) return false
    for (const ancestor of this.getAncestors(target)) {
      if (ancestor === by) return true
    }
    return false
  }

  resolveAccessLayers(agentId: AgentID): readonly ToolAccessRules[] {
    // 祖先链 [父 → … → user0]，逐层取访问规则（越靠前越局部/强）。
    const layers: ToolAccessRules[] = []
    for (const ancestor of this.getAncestors(agentId)) {
      const layer = this.accessLayerOf?.(this.getInstance(ancestor) as AgentInstance)
      if (layer !== undefined) layers.push(layer)
    }
    return layers
  }
}
