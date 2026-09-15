// ============================================================
// core/lineage/LineageTree.ts —— 族谱树（实例层派生事实的唯一门面）
//
// 门面合一：拓扑 + 能力 + 可见域三相合一。"实例树"仅为概念别名。
//
// 模型配置相（出生解析落地）：实例化时一次性求解「显式 > 类基因 >
// 父继承」并物化为节点绑定；改父不动子由已落地绑定天然保证
// （无 snapshot 输入层、无运行期全树 replay）。setModel 只重绑节点
// 自身为 explicit。启动 replay 仅一次（恢复接线）。
//
// 权限相：注册期 attach/replay 物化（AccessLedger 内部）；tools 出生后不可改。
//
// 红线：
//   - 派生态可完整重建（启动按拓扑序重放一次）；
//   - 不承载 status/turnCount 等运行时时间轴；
//   - 零类层依赖：own/类基因由 kernel 算好传入。
// ============================================================

import type { ModelRef } from '../gateway'
import type { AgentID, AgentInstance, ModelBinding } from '../kernel'
import { parentIdOf } from '../kernel'
import type { ToolAccess } from '../tools'
import type { AccessBindEntry, AccessLedger, AccessProfile } from './AccessLedger'
import { DefaultAccessLedger } from './AccessLedger'

// 模型解析形状（ModelBinding/ModelOrigin）住 kernel/types（族谱全局词汇）。
export type { ModelBinding, ModelOrigin } from '../kernel'

/** attach 的模型输入（kernel 计算的原始层；树零类层依赖红线）。 */
export interface ModelBindInput {
  /** 显式层（实例行 model 字段）。 */
  readonly instanceModel?: ModelRef
  /** 类基因层（模板 model；根类 = user 类，其值物化为 home 层）。 */
  readonly classModel?: ModelRef
  /**
   * 已落地绑定（实例行 modelBinding）：启动/重放时优先——自包含，
   * 不需类模板即可恢复；无绑定再按显式/类/父链求解。
   */
  readonly resolved?: ModelBinding
}

/** 绑定条目 = 台账条目 + 模型配置相输入。 */
export interface LineageBindEntry extends AccessBindEntry {
  readonly model?: ModelBindInput
}

/** 节点配置整像（agent_inspect 出示：权限档案 + 模型绑定）。 */
export interface NodeConfig {
  readonly access: AccessProfile
  /** 模型绑定（全链无锚时 undefined——boot 硬校验保证正常不发生）。 */
  readonly model?: ModelBinding
}

/** 统一节点视图（实例行 + 生效能力；各前端只读面）。 */
export interface AgentNodeView {
  readonly instance: AgentInstance
  readonly access: AccessProfile | undefined
  readonly model: ModelBinding | undefined
}

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

  // ---------- 能力（台账物化 + 模型配置相；注册期写入、运行期只读/定向改） ----------
  /** 注册绑定：按父档案 + 自身清单物化（kernel 实例化/根注册调用）。 */
  readonly attach: (entry: LineageBindEntry) => void
  /** 注销（销毁级联时逐节点摘除）。 */
  readonly detach: (agentId: string) => void
  /** 启动重放：任意顺序绑定集合（内部按族谱拓扑序处理一次）。 */
  readonly replay: (entries: readonly LineageBindEntry[]) => void
  /** 运行期模型显式层重绑（只动节点自身为 explicit；不级联）。 */
  readonly setModel: (agentId: string, model: ModelRef) => void
  /** 是否已绑定。 */
  readonly has: (agentId: string) => boolean
  /** 生效访问（undefined = 无人显式判定且无本地兜底 → 调用方落默认值）。 */
  readonly effectiveAccess: (agentId: string, key: string) => ToolAccess | undefined
  /** 节点权限档案（agent_inspect 出示用；只读）。 */
  readonly profileOf: (agentId: string) => AccessProfile | undefined
  /** 生效模型（出生解析落地的绑定；未绑定/无锚 = undefined）。 */
  readonly modelOf: (agentId: string) => ModelBinding | undefined
  /** 节点配置整像（权限 + 模型；未绑定 = undefined）。 */
  readonly nodeConfigOf: (agentId: string) => NodeConfig | undefined
  /** 统一节点视图（实例 + 能力；各前端只读面）。 */
  readonly nodeOf: (agentId: string) => AgentNodeView | undefined

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
  /** 模型配置相：绑定输入（重算依据）与物化绑定。 */
  private readonly modelInputs = new Map<string, { parentId: string | null; input: ModelBindInput }>()
  private readonly modelBindings = new Map<string, ModelBinding>()

  constructor(options: LineageTreeOptions) {
    this.getInstance = options.getInstance
    this.getAllInstances = options.getAllInstances
    this.ledger = new DefaultAccessLedger()
  }

  getParent(agentId: AgentID): AgentID | null {
    return parentIdOf(agentId)
  }

  getChildren(agentId: AgentID): readonly AgentID[] {
    const result: AgentID[] = []
    for (const instance of this.getAllInstances()) {
      if (parentIdOf(instance.id) === agentId) result.push(instance.id)
    }
    return result
  }

  getAncestors(agentId: AgentID): readonly AgentID[] {
    const chain: AgentID[] = []
    let current = parentIdOf(agentId)
    while (current !== null) {
      chain.push(current)
      current = parentIdOf(current)
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

  // ---------- 能力相（委托台账 + 模型配置相） ----------

  attach(entry: LineageBindEntry): void {
    this.ledger.bind(entry)
    this.bindModelNode(entry)
  }

  detach(agentId: string): void {
    this.ledger.unbind(agentId)
    this.modelInputs.delete(agentId)
    this.modelBindings.delete(agentId)
  }

  replay(entries: readonly LineageBindEntry[]): void {
    this.ledger.rebind(entries)
    for (const entry of entries) this.bindModelNode(entry, false)
    this.resolvePendingModels()
  }

  setModel(agentId: string, model: ModelRef): void {
    const binding: ModelBinding = { ref: model, origin: 'explicit' }
    this.modelBindings.set(agentId, binding)
    const record = this.modelInputs.get(agentId)
    if (record !== undefined) {
      this.modelInputs.set(agentId, {
        parentId: record.parentId,
        input: { ...record.input, instanceModel: model, resolved: binding },
      })
    }
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

  modelOf(agentId: string): ModelBinding | undefined {
    return this.modelBindings.get(agentId)
  }

  nodeConfigOf(agentId: string): NodeConfig | undefined {
    const access = this.ledger.profileOf(agentId)
    if (access === undefined) return undefined
    const model = this.modelBindings.get(agentId)
    return { access, ...(model !== undefined ? { model } : {}) }
  }

  nodeOf(agentId: string): AgentNodeView | undefined {
    const instance = this.getInstance(agentId as AgentID)
    if (instance === undefined) return undefined
    return {
      instance,
      access: this.ledger.profileOf(agentId),
      model: this.modelBindings.get(agentId) ?? instance.modelBinding,
    }
  }

  // ---------- 模型相解析（出生落地 + 定向重绑） ----------

  private bindModelNode(entry: LineageBindEntry, resolveNow = true): void {
    const parentId = entry.parentId
    const input = entry.model ?? {}
    this.modelInputs.set(entry.agentId, { parentId, input })
    if (resolveNow) {
      const binding = this.computeModelBinding(entry.agentId)
      if (binding) this.modelBindings.set(entry.agentId, binding)
      else this.modelBindings.delete(entry.agentId)
    }
  }

  private resolvePendingModels(): void {
    const pending = new Set(this.modelInputs.keys())
    let progress = true
    while (pending.size > 0 && progress) {
      progress = false
      for (const id of [...pending]) {
        const record = this.modelInputs.get(id)
        if (record === undefined) {
          pending.delete(id)
          continue
        }
        if (record.parentId === null || record.parentId === id || !pending.has(record.parentId)) {
          const binding = this.computeModelBinding(id)
          if (binding) this.modelBindings.set(id, binding)
          pending.delete(id)
          progress = true
        }
      }
    }
    for (const id of pending) {
      const binding = this.computeModelBinding(id)
      if (binding) this.modelBindings.set(id, binding)
    }
  }

  /** 显式 > 已落地绑定 > 类基因 > 父继承（严格父子相对；根的类基因与非根同语义）。 */
  private computeModelBinding(agentId: string): ModelBinding | undefined {
    const record = this.modelInputs.get(agentId)
    if (record === undefined) return undefined
    const { parentId, input } = record
    if (input.instanceModel !== undefined) return { ref: input.instanceModel, origin: 'explicit' }
    // 自包含：已落地绑定优先于类/父链（重启不需类模板；改父不动子）。
    if (input.resolved !== undefined) return input.resolved
    if (input.classModel !== undefined) return { ref: input.classModel, origin: 'class' }
    if (parentId !== null) {
      const parent = this.modelBindings.get(parentId)
      if (parent !== undefined) {
        return { ref: parent.ref, origin: 'inherited' }
      }
    }
    return undefined // 全链无锚（boot 硬校验 user 类 model 基因，正常不发生）
  }

  // ---------- 可见域 ----------

  canReach(viewer: AgentID, target: AgentID): boolean {
    return viewer === target || this.isAncestorOf(viewer, target)
  }
}
