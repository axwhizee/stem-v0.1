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

// 统一输出成形（成功/失败同一入口 + 窗口限制）
export type { ToolOutputOptions } from './output'
export { formatToolOutput, formatToolError } from './output'

export { restrictAccess, accessRank, checkToolsConvergence, foldConvergenceSteps } from './access'
export type { ConvergenceLayer, ConvergenceStep, ConvergenceStepMode, ConvergenceViolation } from './access'

export type { ShellRunOptions, ShellRunResult, ShellRunner, BashToolSettings } from './internal/bash'
export { createBashTool, formatShellOutput, BASH_DEFAULTS } from './internal/bash'

// internal 工具宿主端口（消费方拥有；kernel 适配器实现、组合根注入）。
export type {
  AgentPort,
  ContextPort,
  TelemetryPort,
  AccessPort,
  SystemToolHost,
  AgentClassView,
  AgentClassInput,
  AgentClassPatchInput,
  AgentInstanceView,
  AgentConfigView,
  InstantiateRequest,
  AgentUpdateRequest,
  StoredMessageView,
} from './internal/ports'

export type { AccessAskOptions, AccessAskBus } from './accessRequest'
export { DefaultAccessAskBus, formatAccessRequest } from './accessRequest'

export type { ToolListFilter, ToolCapabilityRegistry, ToolRegistryOptions } from './ToolCapabilityRegistry'
export { DefaultToolCapabilityRegistry } from './ToolCapabilityRegistry'
