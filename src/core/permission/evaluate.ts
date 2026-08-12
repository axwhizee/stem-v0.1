// ============================================================
// core/permission/evaluate.ts —— 权限评估纯函数
//
// 对齐 opencode：规则集按数组顺序，最后命中的规则优先；
// 未命中任何规则 → 默认 ask（交用户确认）。
// ============================================================

import type { PermissionAction, PermissionRules } from './types'

/** 评估某权限名在规则集下的动作（最后命中优先；缺省 ask）。 */
export function evaluate(permission: string, rules: PermissionRules): PermissionAction {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]
    if (rule !== undefined && rule.tool === permission) return rule.action
  }
  return 'ask'
}

/** 将 AgentClass.permissions（Record<权限名,动作>）转换为规则数组。 */
export function permissionsToRules(permissions: Readonly<Record<string, PermissionAction>> | undefined): PermissionRules {
  return Object.entries(permissions ?? {}).map(([tool, action]) => ({ tool, action }))
}
