// ============================================================
// core/permission/types.ts —— 权限领域类型（纯 TS，零平台依赖）
//
// 统一权限模型（原子化 per-tool）：
//   - 每个工具声明权限名（permission，如 read/edit/grep/glob/bash）；
//   - agent 类声明权限列表（Record<权限名, allow|deny|ask>）；
//   - 评估：规则集 = [agent 类规则, ...session 用户批准]，最后命中优先；
//   - 未在规则中的权限默认 ask（弹窗交用户确认）。
// ============================================================

/** 单个工具的原子权限动作。 */
export type PermissionAction = 'allow' | 'deny' | 'ask'

/** 权限规则（工具权限名 → 动作）。 */
export interface PermissionRule {
  readonly tool: string
  readonly action: PermissionAction
}

/** 权限规则集（数组，最后命中优先；由 AgentClass.permissions 或 approved 生成）。 */
export type PermissionRules = readonly PermissionRule[]

/** 挂起中的权限请求（ask 时产生，交面板弹窗确认）。 */
export interface PermissionRequest {
  readonly id: string
  /** 请求的权限名（工具 permission 名）。 */
  readonly permission: string
  /** 申请该权限的 agent id。 */
  readonly agentId: string
  /** 附带元数据（工具 id、参数摘要等，供面板展示）。 */
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly at: number
}

/** 用户回复（once=单次 / always=始终 / reject=拒绝）。 */
export type PermissionReply = 'once' | 'always' | 'reject'

export interface PermissionReplyInput {
  readonly requestId: string
  readonly reply: PermissionReply
  /** reject 时可带反馈（告知 agent）。 */
  readonly message?: string
}

/** 权限断言输入。 */
export interface PermissionAssertInput {
  readonly permission: string
  readonly agentId: string
  /** agent 类的权限规则（由 AgentClass.permissions 生成）。 */
  readonly rules: PermissionRules
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** 权限错误（判别联合）。 */
export type PermissionError =
  | { readonly kind: 'permission_denied'; readonly permission: string; readonly agentId: string }
  | { readonly kind: 'permission_rejected'; readonly permission: string; readonly requestId: string; readonly feedback?: string }
  | { readonly kind: 'permission_not_found'; readonly requestId: string }
