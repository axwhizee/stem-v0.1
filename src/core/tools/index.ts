// ============================================================
// core/tools/index.ts —— 唯一出口（只 re-export）
// ============================================================

export type {
  ToolCategory,
  ToolPropertySchema,
  ToolParametersSchema,
  ToolInvocation,
  ToolContext,
  ToolReference,
  ToolResult,
  ToolError,
  ToolRecord,
  ToolCapability,
  PermissionResolver,
  ToolHooks,
} from './types'
export { LevelPermissionResolver } from './types'

export { validateArgs } from './validate'

export type { ToolListFilter, ToolCapabilityRegistry, ToolRegistryOptions } from './ToolCapabilityRegistry'
export { DefaultToolCapabilityRegistry } from './ToolCapabilityRegistry'
