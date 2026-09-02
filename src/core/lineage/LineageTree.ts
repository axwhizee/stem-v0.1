// ============================================================
// core/lineage/LineageTree.ts —— 族谱树（实例层派生事实的唯一门面）
//
// 门面合一（方案史见 docs/log.md 与 git 史）：拓扑 + 能力 + 可见域
// 三相合一。"实例树"仅为概念别名，命名保留族谱树。
// S6.1 扩展（docs/s6-plan.md R6/R14）：能力相新增**模型配置相**——
//   全参数统一解析律「显式 > 类基因 > 父继承 > 家学」与权限同门面
//   （tools 与 model 都是"族谱位置的函数"，只是代数不同：收敛格 vs 取先链）。
//
// 关系（拓扑相，原有）：InstanceManager 持有 AgentInstance.parentId
//   （创建时确定、不可变，唯一事实源）；本树不存关系数据，
//   所有拓扑查询基于实例实时推导。
// 能力（能力相，原 AccessLedger 独立并列 → 并入为内部组成）：
//   生效权限 = 族谱位置的函数，注册期由 attach 物化（继承→收敛两步），
//   运行期只读查询（effectiveAccess/profileOf）。台账算法本体不重写，
//   组合 AccessLedger.ts 内部实现（语义矩阵活文档随迁）。
// 模型（配置相，S6 新增）：attach 输入 = kernel 算好的原始层
//   { instanceModel（显式，来自实例行）, classModel（类基因） }——
//   树内物化出生快照（继承→取先两步，origin 呈 git-blame 语义：
//   home 值随链下传不改标）。**setModel 不级联**：重绑节点自身为
//   explicit，已物化的子女快照不动（族规 = 出生快照）。
// 可见域（canReach）：自身 ∪ 祖先代查——一切跨 agent 操作面
//   （context_* 工具、telemetry_query、set_model、销毁/中断权）统一收敛
//   到此谓词，消除各工具内重复的族谱判定散点。
//
// 红线（方案 D2/D3，不因扩展松动）：
//   - 派生态不入库：attach/replay 可完整重建（重启按族谱拓扑序重放；
//     显式层的持久载体是实例行 AgentInstance.model，由 kernel 装载传入）；
//   - 不承载运行时/时间轴状态（status/turnCount/送信 = Runtime/kernel）；
//   - 零类层依赖：自身清单（own）与类基因（classModel）由 kernel 算好传入。
//
// user0 是族谱根（parentId = null）：getAncestors(user0) = []；
// 根无实例/类覆盖时其 classModel（= config.user.model）即**家学层**。
// ============================================================

import type { ModelRef } from '../gateway'
import type { AgentID, AgentInstance, ModelBinding } from '../kernel'
import type { ToolAccess } from '../tools'
import type { AccessBindEntry, AccessLedger, AccessProfile } from './AccessLedger'
import { DefaultAccessLedger } from './AccessLedger'

// 模型解析形状（ModelBinding/ModelOrigin）住 kernel/types（族谱全局词汇：
// 实例行 modelSnapshot 与树物化共用同一形状；本模块 re-export 供消费方）。
export type { ModelBinding, ModelOrigin } from '../kernel'

/** attach 的模型输入（kernel 计算的原始层；树零类层依赖红线）。 */
export interface ModelBindInput {
  /** 显式层（实例行 model 字段）。 */
  readonly instanceModel?: ModelRef
  /** 类基因层（模板 model；根类 = user 类，其值物化为 home 层）。 */
  readonly classModel?: ModelRef
  /**
   * 出生快照层（实例行 modelSnapshot）：replay 时优先于父的当前再解析——
   * 族规"改父不动子（出生快照）"跨重启不失效（S6 §5）。
   */
  readonly snapshot?: ModelBinding
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

  // ---------- 能力（台账物化 + 模型配置相；注册期写入、运行期只读） ----------
  /** 注册绑定：按父档案 + 自身清单物化（kernel 实例化/根注册调用）。 */
  readonly attach: (entry: LineageBindEntry) => void
  /** 注销（销毁级联时逐节点摘除）。 */
  readonly detach: (agentId: string) => void
  /** 重启重放：任意顺序绑定集合（内部按族谱拓扑序处理，纯派生态不入库）。 */
  readonly replay: (entries: readonly LineageBindEntry[]) => void
  /** 是否已绑定。 */
  readonly has: (agentId: string) => boolean
  /** 生效访问（undefined = 无人显式判定且无本地兜底 → 调用方落默认值）。 */
  readonly effectiveAccess: (agentId: string, key: string) => ToolAccess | undefined
  /** 节点权限档案（agent_inspect 出示用；只读）。 */
  readonly profileOf: (agentId: string) => AccessProfile | undefined
  /** 生效模型（解析链四级律的物化结果；未绑定/无锚 = undefined）。 */
  readonly modelOf: (agentId: string) => ModelBinding | undefined
  /**
   * 运行时换模型（set_model 通道）：本节点重绑为 explicit 并记录输入
   * （replay 可完整重建）；**不级联**——已物化的子女出生快照不动。
   */
  readonly setModel: (agentId: string, ref: ModelRef) => void
  /** 节点配置整像（权限 + 模型；未绑定 = undefined）。 */
  readonly nodeConfigOf: (agentId: string) => NodeConfig | undefined

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
  /** 模型配置相：绑定输入（重算依据，不入库）与物化快照。 */
  private readonly modelInputs = new Map<string, { parentId: string | null; input: ModelBindInput }>()
  private readonly modelBindings = new Map<string, ModelBinding>()

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

  // ---------- 能力相（委托台账 + 模型配置相） ----------

  attach(entry: LineageBindEntry): void {
    this.ledger.bind(entry)
    this.modelInputs.set(entry.agentId, { parentId: entry.parentId, input: entry.model ?? {} })
    const binding = this.computeModelBinding(entry.agentId)
    if (binding) this.modelBindings.set(entry.agentId, binding)
    else this.modelBindings.delete(entry.agentId)
  }

  detach(agentId: string): void {
    this.ledger.unbind(agentId)
    this.modelInputs.delete(agentId)
    this.modelBindings.delete(agentId)
  }

  replay(entries: readonly LineageBindEntry[]): void {
    // 权限相：台账内部自带拓扑序处理。
    this.ledger.rebind(entries)
    // 模型相：先全量记录输入，再按族谱拓扑序反复扫描（父先于子；
    // 与台账 rebind 同构——纯派生态，任意顺序绑定集合可完整重建）。
    for (const entry of entries) {
      this.modelInputs.set(entry.agentId, { parentId: entry.parentId, input: entry.model ?? {} })
    }
    const pending = new Map(entries.map((entry) => [entry.agentId, entry]))
    let progress = true
    while (pending.size > 0 && progress) {
      progress = false
      for (const [id, entry] of [...pending]) {
        if (entry.parentId === null || entry.parentId === id || !pending.has(entry.parentId)) {
          const binding = this.computeModelBinding(id)
          if (binding) this.modelBindings.set(id, binding)
          pending.delete(id)
          progress = true
        }
      }
    }
    // 兜底：环/父不在集合内 → 无父档案直接计算（explicit/class 层仍生效）。
    for (const entry of pending.values()) {
      const binding = this.computeModelBinding(entry.agentId)
      if (binding) this.modelBindings.set(entry.agentId, binding)
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

  setModel(agentId: string, ref: ModelRef): void {
    const record = this.modelInputs.get(agentId)
    if (record === undefined) return // 未绑定节点（kernel 通道保证不发生；防御性 no-op）
    this.modelInputs.set(agentId, { ...record, input: { ...record.input, instanceModel: ref } })
    // 只重绑自身：子女出生快照不动（R6"族规=出生快照"，setModel 不级联）。
    this.modelBindings.set(agentId, { ref, origin: 'explicit' })
  }

  nodeConfigOf(agentId: string): NodeConfig | undefined {
    const access = this.ledger.profileOf(agentId)
    if (access === undefined) return undefined
    const model = this.modelBindings.get(agentId)
    return { access, ...(model !== undefined ? { model } : {}) }
  }

  // ---------- 模型相解析（四级律的单点物化） ----------

  /** 显式 > 类基因 > 出生快照 > 父继承 > 家学（根的类层即 home；home 值下传保持 origin）。 */
  private computeModelBinding(agentId: string): ModelBinding | undefined {
    const record = this.modelInputs.get(agentId)
    if (record === undefined) return undefined
    const { parentId, input } = record
    if (input.instanceModel !== undefined) return { ref: input.instanceModel, origin: 'explicit' }
    if (input.classModel !== undefined) return { ref: input.classModel, origin: parentId === null ? 'home' : 'class' }
    // 出生快照优先于父亲行现值（快照 = 出生时族谱真相的持久化）。
    if (input.snapshot !== undefined) return input.snapshot
    if (parentId !== null) {
      const parent = this.modelBindings.get(parentId)
      if (parent !== undefined) {
        return { ref: parent.ref, origin: parent.origin === 'home' ? 'home' : 'inherited' }
      }
    }
    return undefined // 全链无锚（boot 硬校验 config.user.model 保证正常不发生）
  }

  // ---------- 可见域 ----------

  canReach(viewer: AgentID, target: AgentID): boolean {
    return viewer === target || this.isAncestorOf(viewer, target)
  }
}
