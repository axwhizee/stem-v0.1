// ============================================================
// core/kernel/TemplateRegistry.ts —— 模板注册表（AgentClass）
//
// 一切 Agent 都来自 AgentClass 模板（D7）。本模块提供注册/查询/
// 校验，内置示例模板（SimpleChat / Coder）从 templates/*.json 加载，
// 非硬编码角色（code-style §3.2）。
//
// **name 即 id**：AgentClass 无单独 id 字段，注册表以 name 为键。
// ============================================================

import type { AgentClass, AgentClassID, KernelError } from './types'
import type { ToolAccess } from '../tools'

export interface TemplateRegistry {
  readonly register: (cls: AgentClass) => Promise<void>
  readonly update: (name: AgentClassID, patch: Partial<AgentClass>) => Promise<void>
  readonly remove: (name: AgentClassID) => Promise<void>
  readonly get: (name: AgentClassID) => Promise<AgentClass>
  /** 同步读取（供 LineageTree.accessLayerOf 在同步路径解析访问层）。 */
  readonly getSync: (name: AgentClassID) => AgentClass | undefined
  readonly list: () => Promise<AgentClass[]>
  readonly validate: (cls: AgentClass) => Promise<void>
}

export class DefaultTemplateRegistry implements TemplateRegistry {
  private readonly templates = new Map<AgentClassID, AgentClass>()

  constructor(builtin: readonly AgentClass[] = []) {
    for (const cls of builtin) this.templates.set(cls.name, cls)
  }

  async register(cls: AgentClass): Promise<void> {
    await this.validate(cls)
    if (this.templates.has(cls.name)) {
      throw error({ kind: 'template_exists', classId: cls.name })
    }
    this.templates.set(cls.name, cls)
  }

  async update(name: AgentClassID, patch: Partial<AgentClass>): Promise<void> {
    const current = await this.get(name)
    const merged: AgentClass = { ...current, ...patch, name }
    await this.validate(merged)
    this.templates.set(name, merged)
  }

  async remove(name: AgentClassID): Promise<void> {
    if (!this.templates.has(name)) {
      throw error({ kind: 'template_not_found', classId: name })
    }
    this.templates.delete(name)
  }

  async get(name: AgentClassID): Promise<AgentClass> {
    const cls = this.templates.get(name)
    if (!cls) throw error({ kind: 'template_not_found', classId: name })
    return cls
  }

  getSync(name: AgentClassID): AgentClass | undefined {
    return this.templates.get(name)
  }

  async list(): Promise<AgentClass[]> {
    return [...this.templates.values()]
  }

  async validate(cls: AgentClass): Promise<void> {
    const fail = (message: string) => {
      throw error({ kind: 'invalid_template', classId: cls.name, message })
    }
    if (!cls.name || typeof cls.name !== 'string') fail('name 不能为空（name 即类 id）')
    if (!cls.systemPrompt || typeof cls.systemPrompt !== 'string') fail('systemPrompt 不能为空')
    if (!cls.description || typeof cls.description !== 'string') fail('description 不能为空')
    for (const [tool, action] of Object.entries(cls.tools ?? {})) {
      if (!isToolAccess(action)) fail(`工具清单 ${tool}=${String(action)} 非法（允许 allow/ask/deny/ignore）`)
    }
  }
}

function isToolAccess(value: unknown): value is ToolAccess {
  return value === 'allow' || value === 'deny' || value === 'ask' || value === 'ignore'
}

function error(e: KernelError): KernelError {
  return e
}
