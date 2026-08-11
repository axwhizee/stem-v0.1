// ============================================================
// core/kernel/AgentTemplateRegistry.ts —— 模板注册表（AgentClass）
//
// 一切 Agent 都来自 AgentClass 模板（D7）。本模块提供注册/查询/
// 校验，内置示例模板（SimpleChat / Coder）从 templates/*.json 加载，
// 非硬编码角色（code-style §3.2）。
// ============================================================

import type { AgentClass, AgentClassID, KernelError, PermissionLevel } from './types'

export interface TemplateListFilter {
  readonly permission?: PermissionLevel
}

export interface AgentTemplateRegistry {
  readonly register: (cls: AgentClass) => Promise<void>
  readonly update: (id: AgentClassID, patch: Partial<AgentClass>) => Promise<void>
  readonly remove: (id: AgentClassID) => Promise<void>
  readonly get: (id: AgentClassID) => Promise<AgentClass>
  readonly list: (filter?: TemplateListFilter) => Promise<AgentClass[]>
  readonly validate: (cls: AgentClass) => Promise<void>
}

export class DefaultAgentTemplateRegistry implements AgentTemplateRegistry {
  private readonly templates = new Map<AgentClassID, AgentClass>()

  constructor(builtin: readonly AgentClass[] = []) {
    for (const cls of builtin) this.templates.set(cls.id, cls)
  }

  async register(cls: AgentClass): Promise<void> {
    await this.validate(cls)
    if (this.templates.has(cls.id)) {
      throw error({ kind: 'template_exists', classId: cls.id })
    }
    this.templates.set(cls.id, cls)
  }

  async update(id: AgentClassID, patch: Partial<AgentClass>): Promise<void> {
    const current = await this.get(id)
    const merged: AgentClass = { ...current, ...patch, id }
    await this.validate(merged)
    this.templates.set(id, merged)
  }

  async remove(id: AgentClassID): Promise<void> {
    if (!this.templates.has(id)) {
      throw error({ kind: 'template_not_found', classId: id })
    }
    this.templates.delete(id)
  }

  async get(id: AgentClassID): Promise<AgentClass> {
    const cls = this.templates.get(id)
    if (!cls) throw error({ kind: 'template_not_found', classId: id })
    return cls
  }

  async list(filter?: TemplateListFilter): Promise<AgentClass[]> {
    const all = [...this.templates.values()]
    if (!filter?.permission) return all
    return all.filter((cls) => cls.permission === filter.permission)
  }

  async validate(cls: AgentClass): Promise<void> {
    const fail = (message: string) => {
      throw error({ kind: 'invalid_template', classId: cls.id, message })
    }
    if (!cls.id || typeof cls.id !== 'string') fail('id 不能为空')
    if (!cls.name || typeof cls.name !== 'string') fail('name 不能为空')
    if (!cls.systemPrompt || typeof cls.systemPrompt !== 'string') fail('systemPrompt 不能为空')
    if (!cls.description || typeof cls.description !== 'string') fail('description 不能为空')
    if (!isPermissionLevel(cls.permission)) fail(`非法权限等级: ${String(cls.permission)}`)
  }
}

function isPermissionLevel(value: unknown): value is PermissionLevel {
  return value === 'normal' || value === 'advanced' || value === 'admin'
}

function error(e: KernelError): KernelError {
  return e
}
