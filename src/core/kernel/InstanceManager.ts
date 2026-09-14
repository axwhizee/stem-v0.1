// ============================================================
// core/kernel/InstanceManager.ts —— 实例管理器（身份注册表）
//
// 身份两件套（B1/B2）：
//   - id = 出生路径，系统全托管：根 `0`；子 = `<父id>-<出生序号>`。序号 1 起、
//     永不回收——terminate 留归档墓碑（status='terminated'），计数器含墓碑行
//     （restore 扫描立地板）；地址复用 = 历史信件指错实体，绝对禁止。
//   - name = 可变称呼，全局唯一：出生显式（撞名拒，绝不自动后缀）或缺省
//     确定性推导 `类名-N`（扫描含墓碑，可复现无随机）；改名撞名拒。
// 寻址解析（B3）：`name#id` 精确制导 → 精确 id → 唯一 id 前缀 → name。
// 总线/邮局注册由 Kernel 在实例化流程中完成。
// ============================================================

import type { TemplateRegistry } from './TemplateRegistry'
import type { AgentClassID, AgentID, AgentInstance, AgentInstancePatch, AgentStatus, ModelBinding } from './types'
import { formatFull, makeAgentID, ROOT_ID } from './types'
import type { ToolAccess } from '../tools'
import type { ModelRef } from '../gateway'

export interface InstantiateOptions {
  /** 模板名（= 模板键）。 */
  readonly className: AgentClassID
  /** 族谱父（= 创建者；根为 null）。创建时确定、不可变；id 由此派生。 */
  readonly parentId: AgentID | null
  /** 实例化必填的 user prompt（首封信）。 */
  readonly userPrompt: string
  /**
   * 出生称呼（缺省确定性推导 `类名-N`）。撞全局名 = 拒绝（绝不自动后缀）。
   * id 不接受显式指定（出生路径全托管；旧 agentId 参数已退役）。
   */
  readonly name?: string
  /** 实例化时传入的工具清单补充（对模板表的收敛，可临时收紧）。 */
  readonly tools?: Readonly<Record<string, ToolAccess>>
  /**
   * 显式模型（解析链最高层；落实例行 = 持久载体）。
   * 缺省 = 不显式，落类基因/父继承/家学链。
   */
  readonly model?: ModelRef
  /**
   * 台账绑定模式（缺省 'inherit' 减法收敛）。'grant' 加法整表替换**仅限系统
   * 机制通道**（策略 spawn / pilot 初始化）；agent_instantiate 工具路径不可设。
   */
  readonly accessMode?: 'inherit' | 'grant'
  /**
   * 上下文传递：父 agent 指定仓库消息索引（消息 id 列表），
   * 实例化时组装进新上下文空间（深拷贝）。
   */
  readonly contextRefs?: readonly string[]
  /**
   * 等待配对（agent_instantiate.wait 内核编排；InstanceManager 无视此字段）：
   * 注册"父等子回信"的 hold 先于首信投递——子的回复永不可能抢在配对之前，
   * 竞态从时序上根除。toolCallId = 父本次工具调用（回信正规填充为 tool 行）。
   */
  readonly hold?: { readonly toolCallId: string; readonly timeoutMs?: number }
  /** 出生模型绑定（kernel 解析后传入；自包含持久）。 */
  readonly modelBinding?: ModelBinding
}

/** 寻址解析结果（B3 三形态）。 */
export type ResolveResult =
  | { readonly found: AgentID }
  | { readonly ambiguous: readonly string[] }
  | { readonly notFound: true }

export interface InstanceManager {
  readonly instantiate: (opts: InstantiateOptions) => Promise<AgentInstance>
  /** 终止：销毁权校验（by 是目标的祖先；根 parentId=null 无祖先 → 不可销毁）+ 有活跃子时默认拒绝，recursive 级联。活体面移除、留下占用（墓碑）。 */
  readonly terminate: (agentId: AgentID, opts?: { by?: AgentID; recursive?: boolean }) => Promise<void>
  readonly get: (agentId: AgentID) => Promise<AgentInstance>
  /** 全部活体实例（供 LineageTree 实时推导 children/descendants；墓碑不在场）。 */
  readonly listAll: () => Promise<readonly AgentInstance[]>
  /** 同步读取（供 LineageTree/materialize 在同步路径解析访问层）。 */
  readonly getSync: (agentId: AgentID) => AgentInstance | undefined
  /** 同步快照（供 LineageTree 扫描 children/descendants；墓碑不在场）。 */
  readonly listAllSync: () => readonly AgentInstance[]
  readonly updateStatus: (agentId: AgentID, status: AgentStatus) => Promise<void>
  /** 轮末账目（turnCount/totalCost/totalTokens 的唯一累加通道——经装饰器即写穿落行，
   *  杜绝「引用直改不落库」的记账滞后；Runtime 每轮收尾调用一次。tokens = 该轮
   *  usage in+out，累计终身量、与 compact 归档无关）。 */
  readonly recordTurnEnd: (agentId: AgentID, stats: { readonly turns: number; readonly cost: number; readonly tokens: number }) => Promise<void>
  /**
   * 运行期实例参数更新（agent config 统一通道的行写半段）：只写提及字段
   * （name / toolOverride / model 显式层），写穿装饰器负责落行——族谱重算由
   * kernel.updateAgent 编排。name 写在此处做全局唯一执法（撞名拒）。
   */
  readonly update: (agentId: AgentID, patch: Partial<AgentInstancePatch>) => Promise<void>
  /**
   * 写出生模型绑定（kernel attach 后调用）：自包含持久载体，
   * 重启不需类模板恢复运行模型；改父不动子由已落地绑定保证。
   */
  readonly setModelBinding: (agentId: AgentID, binding: ModelBinding) => Promise<void>
  /** 反馈式上下文占用（最近一次 prompt_tokens；runtime/attributeUsage 写入）。 */
  readonly setCtxTokens: (agentId: AgentID, tokens: number) => Promise<void>
  /**
   * 持久化恢复专用（绕过模板校验，仅由组合根启动期调用）：
   * 直接装载实例行；活跃状态归一化——thinking/holding → interrupted
   *（进程已死，halt 语义下消息闭合，"可恢复中断"语义现成）。
   * 墓碑行（status='terminated'）不进活体面，只立身份占用（B1 计数器地板）。
   */
  readonly restore: (instance: AgentInstance) => void
  /** 寻址解析（B3 三形态）：`name#id` 精确制导 → 精确 id → 唯一 id 前缀 → name。 */
  readonly resolve: (ref: string) => ResolveResult
  /** 全名呈现（`name#id`；未知 id 回落裸 id——信件戳/列表的统一出口）。 */
  readonly displayOf: (agentId: string) => string
  /** 装载期唯一性校验：活体+墓碑行集合内 name 重复 = 真相被手改（boot 硬错料）。 */
  readonly assertNamesUnique: (records: readonly AgentInstance[]) => string[]
}

/** 销毁权错误（判别联合）。 */
type TerminateError =
  | { readonly kind: 'agent_terminate_denied'; readonly agentId: AgentID; readonly by: string }
  | { readonly kind: 'agent_has_children'; readonly agentId: AgentID; readonly hint: string }

export class DefaultInstanceManager implements InstanceManager {
  private readonly agents = new Map<AgentID, AgentInstance>()
  /** 各父的出生序号高水位（含已销毁/墓碑占用——永不回收，键 = parentId，根用 '' 键）。 */
  private readonly childSeq = new Map<string, number>()
  /** 各类派生名 `类名-N` 的 N 高水位（restore 扫描含墓碑立地板）。 */
  private readonly classSeq = new Map<AgentClassID, number>()
  /** 全部在册称呼（活体 + 墓碑）：全局唯一执法域。 */
  private readonly names = new Set<string>()

  constructor(private readonly registry: TemplateRegistry) {}

  async instantiate(opts: InstantiateOptions): Promise<AgentInstance> {
    // 校验模板存在。
    const template = await this.registry.get(opts.className)
    if (typeof opts.userPrompt !== 'string') {
      throw { kind: 'agent_conflict', message: 'userPrompt 是必填项（字符串）' }
    }
    if (opts.parentId === undefined) {
      throw { kind: 'agent_conflict', message: 'parentId 是必填项（根为 null）' }
    }
    // 父必须是已存在的实例（根 parentId=null 除外）。
    if (opts.parentId !== null && !this.agents.has(opts.parentId)) {
      throw { kind: 'agent_conflict', message: `父 agent 不存在: ${String(opts.parentId)}` }
    }

    // id = 出生路径（B1 全托管：无显式指定通道；序号永不回收）。
    const id = this.nextChildId(opts.parentId)
    if (this.agents.has(id)) {
      throw { kind: 'agent_conflict', message: `agent id 冲突: ${id}` }
    }
    // name = 显式（撞名直接拒，绝不自动后缀）或确定性推导 `类名-N`（B2）。
    let name: string
    if (opts.name !== undefined) {
      if (this.names.has(opts.name)) {
        throw { kind: 'agent_name_conflict', name: opts.name, message: `称呼已被占用（含归档墓碑）: ${opts.name}——撞全局名被拒，请换一个` }
      }
      name = opts.name
    } else {
      name = this.deriveName(template.name)
    }
    this.names.add(name)

    const instance: AgentInstance = {
      id,
      classRef: template.name,
      parentId: opts.parentId,
      name,
      status: 'idle',
      turnCount: 0,
      totalCost: 0,
      totalTokens: 0,
      userPrompt: opts.userPrompt,
      ...(opts.tools !== undefined ? { toolOverride: opts.tools } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.modelBinding !== undefined ? { modelBinding: opts.modelBinding } : {}),
    }
    this.agents.set(id, instance)
    return instance
  }

  async terminate(
    agentId: AgentID,
    opts?: { by?: AgentID; recursive?: boolean },
  ): Promise<void> {
    await this.get(agentId) // 存在性 fail-fast（缺失抛 agent_not_found）
    const by: AgentID = opts?.by ?? ROOT_ID
    // 销毁权：by 必须是目标的祖先（根 parentId=null 无祖先 → 天然不可销毁）。
    if (!this.isAncestorOf(by, agentId)) {
      throw { kind: 'agent_terminate_denied', agentId, by } satisfies TerminateError
    }
    // 默认禁止销毁有活跃子的父（先处理子）；recursive 级联整棵子树。
    const children = this.directChildren(agentId)
    if (children.length > 0 && !opts?.recursive) {
      throw {
        kind: 'agent_has_children',
        agentId,
        hint: `agent ${agentId} 仍有 ${children.length} 个子 agent，请先处理子 agent 或传 recursive: true 级联销毁`,
      } satisfies TerminateError
    }
    if (opts?.recursive) {
      for (const child of children) await this.terminate(child, { by, recursive: true })
    }
    // 活体面移除；id/name 占用保留（childSeq/names 均不回退——墓碑语义）。
    this.agents.delete(agentId)
  }

  async get(agentId: AgentID): Promise<AgentInstance> {
    const instance = this.agents.get(agentId)
    if (!instance) throw { kind: 'agent_not_found', agentId }
    return instance
  }

  async listAll(): Promise<readonly AgentInstance[]> {
    return [...this.agents.values()]
  }

  getSync(agentId: AgentID): AgentInstance | undefined {
    return this.agents.get(agentId)
  }

  listAllSync(): readonly AgentInstance[] {
    return [...this.agents.values()]
  }

  async updateStatus(agentId: AgentID, status: AgentStatus): Promise<void> {
    const instance = await this.get(agentId)
    instance.status = status
  }

  async recordTurnEnd(agentId: AgentID, stats: { readonly turns: number; readonly cost: number; readonly tokens: number }): Promise<void> {
    const instance = await this.get(agentId)
    instance.turnCount += stats.turns
    instance.totalCost += stats.cost
    instance.totalTokens = (instance.totalTokens ?? 0) + stats.tokens
  }

  async update(agentId: AgentID, patch: Partial<AgentInstancePatch>): Promise<void> {
    const instance = await this.get(agentId)
    // 就地改写（对象引用被 Runtime/装饰器共享，替换对象会使旧引用脱钩）；
    // readonly 是对外面契约，本方法是 kernel 授权后的唯一行写出口。
    const mutable = instance as {
      name?: string
      toolOverride?: Readonly<Record<string, ToolAccess>>
      model?: ModelRef
      modelBinding?: ModelBinding
    }
    if (patch.name !== undefined && patch.name !== instance.name) {
      // 改名撞名拒（全局唯一执法面含墓碑）；旧名释放占用。
      if (this.names.has(patch.name)) {
        throw { kind: 'agent_name_conflict', name: patch.name, message: `称呼已被占用（含归档墓碑）: ${patch.name}——改名撞全局名被拒` }
      }
      this.names.delete(instance.name)
      this.names.add(patch.name)
      mutable.name = patch.name
    }
    if (patch.toolOverride !== undefined) mutable.toolOverride = patch.toolOverride
    if (patch.model !== undefined) {
      mutable.model = patch.model
      // 显式层改写 = 绑定同步为 explicit（改自身，不碰子女）。
      mutable.modelBinding = { ref: patch.model, origin: 'explicit' }
    }
  }

  async setModelBinding(agentId: AgentID, binding: ModelBinding): Promise<void> {
    const instance = await this.get(agentId)
    ;(instance as { modelBinding?: ModelBinding }).modelBinding = binding
  }

  async setCtxTokens(agentId: AgentID, tokens: number): Promise<void> {
    const instance = await this.get(agentId)
    ;(instance as { ctxTokens?: number }).ctxTokens = tokens
  }

  restore(instance: AgentInstance): void {
    // 墓碑行只立占用（id 序号 / name 在册），永不进活体面。
    if (instance.status === 'terminated') {
      this.reserveIdentity(instance)
      return
    }
    if (this.agents.has(instance.id)) return
    this.reserveIdentity(instance)
    const status: AgentStatus =
      instance.status === 'thinking' || instance.status === 'holding' ? 'interrupted' : instance.status
    // 旧库缺 modelBinding：用显式 model 兜底为 explicit（类基因/父链由上层 attach 补）。
    const modelBinding =
      instance.modelBinding ??
      (instance.model !== undefined ? ({ ref: instance.model, origin: 'explicit' } as ModelBinding) : undefined)
    this.agents.set(instance.id, {
      ...instance,
      status,
      totalTokens: instance.totalTokens ?? 0,
      ...(modelBinding !== undefined ? { modelBinding } : {}),
    })
  }

  resolve(ref: string): ResolveResult {
    const hash = ref.lastIndexOf('#')
    if (hash > 0 && hash < ref.length - 1) {
      // `name#id` 精确制导：id 在场且 name 吻合才算命中。
      const id = this.agents.get(ref.slice(hash + 1) as AgentID)
      if (id !== undefined && id.name === ref.slice(0, hash)) return { found: id.id }
      return { notFound: true }
    }
    const exact = this.agents.get(ref as AgentID)
    if (exact) return { found: exact.id }
    const byPrefix = [...this.agents.values()].filter((a) => a.id.startsWith(ref)).map((a) => a.id)
    if (byPrefix.length === 1) return { found: byPrefix[0]! }
    if (byPrefix.length > 1) {
      return { ambiguous: byPrefix.map((id) => this.displayOf(id)) }
    }
    const byName = [...this.agents.values()].find((a) => a.name === ref)
    if (byName) return { found: byName.id }
    return { notFound: true }
  }

  displayOf(agentId: string): string {
    const instance = this.agents.get(agentId as AgentID)
    return instance ? formatFull(instance.name, instance.id) : agentId
  }

  assertNamesUnique(records: readonly AgentInstance[]): string[] {
    const seen = new Set<string>()
    const dup: string[] = []
    for (const record of records) {
      if (seen.has(record.name)) dup.push(record.name)
      else seen.add(record.name)
    }
    return dup
  }

  /** 祖先链判定（根 parentId=null 终止；路径前缀 ⇔ 结构祖先——此处走结构真相）。 */
  private isAncestorOf(by: AgentID, target: AgentID): boolean {
    let current: AgentInstance | undefined = this.agents.get(target)
    while (current?.parentId != null) {
      if (current.parentId === by) return true
      current = this.agents.get(current.parentId)
    }
    return false
  }

  private directChildren(agentId: AgentID): AgentID[] {
    return [...this.agents.values()].filter((a) => a.parentId === agentId).map((a) => a.id)
  }

  /** 出生路径分配：`<父id>-<高水位+1>`（根的子挂 '0' 下）。 */
  private nextChildId(parentId: AgentID | null): AgentID {
    if (parentId === null) return ROOT_ID
    const key = parentId
    const next = (this.childSeq.get(key) ?? 0) + 1
    this.childSeq.set(key, next)
    return makeAgentID(`${parentId}-${next}`)
  }

  /** 恢复/出生共用的占用登记：childSeq 地板、classSeq 地板、names 在册。 */
  private reserveIdentity(instance: AgentInstance): void {
    if (instance.parentId !== null) {
      const suffix = Number(instance.id.slice(instance.parentId.length + 1))
      if (Number.isFinite(suffix)) {
        this.childSeq.set(instance.parentId, Math.max(this.childSeq.get(instance.parentId) ?? 0, suffix))
      }
    }
    this.names.add(instance.name)
    const derived = derivedSeqOf(instance.classRef, instance.name)
    if (derived !== undefined) {
      this.classSeq.set(instance.classRef, Math.max(this.classSeq.get(instance.classRef) ?? 0, derived))
    }
  }

  /** 确定性派生 `类名-N`：N = 该类高水位+1，撞在册名（如显式名恰好同形）继续进位。 */
  private deriveName(className: AgentClassID): string {
    let n = (this.classSeq.get(className) ?? 0) + 1
    while (this.names.has(`${className}-${n}`)) n++
    this.classSeq.set(className, n)
    return `${className}-${n}`
  }
}

/** 若 name 恰为 `<类名>-N` 派生形则返回 N（高水位回放的解析口），否则 undefined。 */
function derivedSeqOf(className: AgentClassID, name: string): number | undefined {
  const prefix = `${className}-`
  if (!name.startsWith(prefix)) return undefined
  const n = Number(name.slice(prefix.length))
  return Number.isInteger(n) && n > 0 && String(n) === name.slice(prefix.length) ? n : undefined
}
