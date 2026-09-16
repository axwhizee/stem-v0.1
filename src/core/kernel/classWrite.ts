// ============================================================
// core/kernel/classWrite.ts —— 类书写面（注册 / 更新 / 落盘）
//
// tools 收敛硬门禁在 updateClass 写入面本层；工具层只做 agent 预检。
// ============================================================

import type { LogEvent } from '../logging'
import { checkToolsConvergence } from '../tools'
import type { TemplateRegistry } from './TemplateRegistry'
import type { AgentClass, AgentClassID, KernelError } from './types'
import type { ClassStore } from './Kernel'

export interface ClassWriteDeps {
  readonly templates: TemplateRegistry
  readonly classStore?: ClassStore
  readonly emitLog: (event: LogEvent) => void
}

export async function registerAgentClass(
  deps: ClassWriteDeps,
  cls: AgentClass,
  opts?: { persist?: boolean; by?: string },
): Promise<{ persisted: boolean }> {
  await deps.templates.register(cls)
  const persisted = await persistClass(deps, cls, opts)
  deps.emitLog({
    type: 'kernel.class.registered',
    at: Date.now(),
    classId: cls.name,
    persisted,
    ...(opts?.by !== undefined ? { agentId: opts.by } : {}),
  })
  return { persisted }
}

/**
 * 更新 agent 类：tools 收敛校验在本层（直调 kernel 不可绕过）。
 * 更新只影响后续实例。
 */
export async function updateAgentClass(
  deps: ClassWriteDeps,
  name: AgentClassID,
  patch: Partial<AgentClass>,
  opts?: { persist?: boolean; by?: string },
): Promise<{ persisted: boolean; cls: AgentClass }> {
  if (patch.tools !== undefined) {
    const current = deps.templates.getSync(name)
    if (current !== undefined) {
      const violations = checkToolsConvergence(current.tools, patch.tools)
      if (violations.length > 0) {
        throw {
          kind: 'invalid_template',
          classId: name,
          message: `工具清单只能收敛：${violations.join('；')}`,
        } satisfies KernelError
      }
    }
  }
  await deps.templates.update(name, patch)
  const merged = await deps.templates.get(name)
  const persisted = await persistClass(deps, merged, opts)
  deps.emitLog({
    type: 'kernel.class.updated',
    at: Date.now(),
    classId: merged.name,
    patch: Object.keys(patch).join(','),
    persisted,
    ...(opts?.by !== undefined ? { agentId: opts.by } : {}),
  })
  return { persisted, cls: merged }
}

async function persistClass(
  deps: ClassWriteDeps,
  cls: AgentClass,
  opts?: { persist?: boolean },
): Promise<boolean> {
  if (opts?.persist !== true || deps.classStore === undefined) return false
  await deps.classStore.save(cls)
  return true
}
