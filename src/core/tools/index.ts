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
  ToolInitContext,
  ToolInitFs,
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
  AccessResolver,
} from './types'

export { validateArgs } from './validate'

export { restrictAccess } from './access'

export type { ShellRunOptions, ShellRunResult, ShellRunner, BashToolSettings } from './bash'
export { createBashTool, formatShellOutput, BASH_DEFAULTS } from './bash'

export type { AccessAskOptions, AccessAskBus } from './accessRequest'
export { DefaultAccessAskBus, formatAccessRequest } from './accessRequest'

export type { ToolListFilter, ToolCapabilityRegistry, ToolRegistryOptions } from './ToolCapabilityRegistry'
export { DefaultToolCapabilityRegistry } from './ToolCapabilityRegistry'
