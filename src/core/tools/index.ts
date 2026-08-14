// ============================================================
// core/tools/index.ts —— 唯一出口（只 re-export）
// ============================================================

export type {
  ToolCategory,
  ToolKind,
  ToolPropertySchema,
  ToolParametersSchema,
  ToolInvocation,
  ToolContext,
  ToolReference,
  ToolResult,
  ToolError,
  ToolRecord,
  ToolCapability,
  ToolHooks,
  ToolAccess,
  ToolAccessRule,
  ToolAccessRules,
  AccessRequest,
  AccessReply,
  AccessReplyInput,
  AccessAssertInput,
  AccessError,
} from './types'

export { validateArgs } from './validate'

export { evaluateAccess, restrictAccess, accessInLayer, toolAccessToRules } from './access'

export type { AccessManagerOptions, AccessManager } from './AccessManager'
export { DefaultAccessManager } from './AccessManager'

export type { ToolListFilter, ToolCapabilityRegistry, ToolRegistryOptions } from './ToolCapabilityRegistry'
export { DefaultToolCapabilityRegistry } from './ToolCapabilityRegistry'
