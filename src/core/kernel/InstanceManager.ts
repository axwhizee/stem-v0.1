// ============================================================
// core/kernel/InstanceManager.ts —— 实例管理器
//
// 实例化必填：classId + userPrompt + creatorId（用户默认 'user0'）。
// id 可显式指定（冲突报错），默认随机 4 位 hash。
// 总线/邮局注册由 Kernel 在实例化流程中完成。
// ============================================================

import type { TemplateRegistry } from './TemplateRegistry'
import type { AgentClassID, AgentID, AgentInstance, AgentInstancePatch, AgentSpaceID, AgentStatus } from './types'
import { makeAgentID } from './types'
import type { ToolAccess } from '../tools'

export interface InstantiateOptions {
  /** 模板名（= 模板键）。 */
  readonly className: AgentClassID
  /** 族谱父（= 创建者；user0 为 null 即根）。创建时确定、不可变。 */
  readonly parentId: AgentID | null
  /** 实例化必填的 user prompt（首封信）。 */
  readonly userPrompt: string
  readonly spaceId: AgentSpaceID
  /** 显式指定 id（与现有实例冲突时报错）。 */
  readonly agentId?: string
  /** 实例化时传入的工具清单补充（对模板表的收敛，可临时收紧）。 */
  readonly tools?: Readonly<Record<string, ToolAccess>>
  /**
   * 上下文传递：父 agent 指定仓库消息索引（消息 id 列表），
   * 实例化时组装进新上下文空间（深拷贝）。
   */
  readonly contextRefs?: readonly string[]
}

export interface InstanceManager {
  readonly instantiate: (opts: InstantiateOptions) => Promise<AgentInstance>
  /** 终止：销毁权校验（by 是目标的祖先；根 parentId=null 无祖先 → 不可销毁）+ 有活跃子时默认拒绝，recursive 级联。 */
  readonly terminate: (agentId: AgentID, opts?: { by?: AgentID; recursive?: boolean }) => Promise<void>
  readonly get: (agentId: AgentID) => Promise<AgentInstance>
  readonly listBySpace: (spaceId: AgentSpaceID) => Promise<AgentInstance[]>
  /** 全部实例（供 LineageTree 实时推导 children/descendants）。 */
  readonly listAll: () => Promise<readonly AgentInstance[]>
  /** 同步读取（供 LineageTree/materialize 在同步路径解析访问层）。 */
  readonly getSync: (agentId: AgentID) => AgentInstance | undefined
  /** 同步快照（供 LineageTree 扫描 children/descendants）。 */
  readonly listAllSync: () => readonly AgentInstance[]
  readonly updateStatus: (agentId: AgentID, status: AgentStatus) => Promise<void>
  readonly takeover: (agentId: AgentID, patch: Partial<AgentInstancePatch>) => Promise<void>
  /**
   * 持久化恢复专用（绕过模板校验，仅由组合根启动期调用）：
   * 直接装载实例行；活跃状态归一化——thinking/holding → interrupted
   *（进程已死，halt 语义下消息闭合，"可恢复中断"语义现成）。
   */
  readonly restore: (instance: AgentInstance) => void
}

/** 销毁权错误（判别联合）。 */
export type TerminateError =
  | { readonly kind: 'agent_terminate_denied'; readonly agentId: AgentID; readonly by: string }
  | { readonly kind: 'agent_has_children'; readonly agentId: AgentID; readonly hint: string }

export class DefaultInstanceManager implements InstanceManager {
  private readonly agents = new Map<AgentID, AgentInstance>()
  private counter = 0

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

    const id = opts.agentId !== undefined ? makeAgentID(opts.agentId) : this.generateId()
    if (this.agents.has(id)) {
      throw { kind: 'agent_conflict', message: `agent id 冲突: ${id}` }
    }

    const instance: AgentInstance = {
      id,
      classRef: template.name,
      parentId: opts.parentId,
      displayName: template.name,
      spaceId: opts.spaceId,
      status: 'idle',
      turnCount: 0,
      totalCost: 0,
      userPrompt: opts.userPrompt,
      ...(opts.tools !== undefined ? { toolOverride: opts.tools } : {}),
    }
    this.agents.set(id, instance)
    return instance
  }

  async terminate(
    agentId: AgentID,
    opts?: { by?: AgentID; recursive?: boolean },
  ): Promise<void> {
    const instance = await this.get(agentId)
    const by: AgentID = opts?.by ?? makeAgentID('user0')
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
    this.agents.delete(agentId)
  }

  async get(agentId: AgentID): Promise<AgentInstance> {
    const instance = this.agents.get(agentId)
    if (!instance) throw { kind: 'agent_not_found', agentId }
    return instance
  }

  async listBySpace(spaceId: AgentSpaceID): Promise<AgentInstance[]> {
    return [...this.agents.values()].filter((a) => a.spaceId === spaceId)
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

  async takeover(agentId: AgentID, patch: Partial<AgentInstancePatch>): Promise<void> {
    const instance = await this.get(agentId)
    if (patch.displayName !== undefined) instance.displayName = patch.displayName
  }

  restore(instance: AgentInstance): void {
    if (this.agents.has(instance.id)) return
    const status: AgentStatus =
      instance.status === 'thinking' || instance.status === 'holding' ? 'interrupted' : instance.status
    this.agents.set(instance.id, { ...instance, status })
  }

  /** 祖先链判定（user0 恒为根）。 */
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

  private generateId(): AgentID {
    for (let attempt = 0; attempt < 20; attempt++) {
      const id = Math.random().toString(36).slice(2, 6).padStart(4, '0')
      if (!this.agents.has(id as AgentID)) return id as AgentID
    }
    throw { kind: 'agent_conflict', message: '无法生成唯一 agent id' }
  }
}
