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
  ToolResult,
  ToolError,
  ToolRecord,
  ToolCapability,
  ToolAccess,
  AccessRequest,
  AccessReply,
  AccessReplyInput,
  AccessAssertInput,
  AccessError,
  AccessResolver,
} from './types'

export { validateArgs } from './validate'

// 统一输出成形（成功/失败同一入口 + 窗口限制）
export type { ToolOutputOptions } from './output'
export { formatToolOutput, formatToolError } from './output'

export { restrictAccess, accessRank, checkToolsConvergence, foldConvergenceSteps } from './access'
export type { ConvergenceLayer, ConvergenceStep, ConvergenceStepMode, ConvergenceViolation } from './access'

export type { ShellRunOptions, ShellRunResult, ShellRunner, BashToolSettings } from './internal/bash'
export { createBashTool } from './internal/bash'

export type { AccessAskOptions, AccessAskBus } from './accessRequest'
export { DefaultAccessAskBus, formatAccessRequest } from './accessRequest'

export type { ToolListFilter, ToolCapabilityRegistry, ToolRegistryOptions } from './ToolCapabilityRegistry'
export { DefaultToolCapabilityRegistry } from './ToolCapabilityRegistry'
