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
  ToolPhase,
  ToolRecord,
  ToolCapability,
  ToolAccess,
  AccessError,
  AccessResolver,
} from './types'
export { isToolError, TOOL_ERROR_KINDS } from './types'

export { validateArgs } from './validate'

// 统一输出成形（成功/失败同一入口 + 窗口限制）
export type { ToolOutputOptions } from './output'
export { formatToolOutput, formatToolError, errorBrief } from './output'

export { restrictAccess, accessRank, checkToolsConvergence, foldConvergenceSteps } from './access'
export type { ConvergenceLayer, ConvergenceStep, ConvergenceStepMode, ConvergenceViolation } from './access'

export type { ShellRunOptions, ShellRunResult, ShellRunner, BashToolSettings } from './internal/bash'
export { createBashTool } from './internal/bash'

export type { ToolListFilter, ToolCapabilityRegistry, ToolRegistryOptions } from './ToolCapabilityRegistry'
export { DefaultToolCapabilityRegistry } from './ToolCapabilityRegistry'
