// ============================================================
// core/permission/index.ts —— 唯一出口
// ============================================================

export type {
  PermissionAction,
  PermissionRule,
  PermissionRules,
  PermissionRequest,
  PermissionReply,
  PermissionReplyInput,
  PermissionAssertInput,
  PermissionError,
} from './types'

export { evaluate, permissionsToRules } from './evaluate'

export type { PermissionManagerOptions, PermissionManager } from './PermissionManager'
export { DefaultPermissionManager } from './PermissionManager'
