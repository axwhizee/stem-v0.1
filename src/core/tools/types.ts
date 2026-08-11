// ============================================================
// core/tools/types.ts —— 工具系统领域类型（纯 TS，零平台依赖）
//
// 设计要点（可扩展性优先）：
//  1. ToolContext 是开放接口 —— 权限管理、MCP、日志等宿主能力
//     以「字段注入」方式扩展，core 只定义最小必要字段；
//  2. 权限校验走可插拔的 PermissionResolver（默认分级校验，
//     未来可换策略：deny 列表、人工确认、子 agent 权限继承…）；
//  3. 执行生命周期暴露 ToolHooks（before/after/error），
//     供 telemetry、MCP 网关、限流、审计等横切能力挂载；
//  4. category 分类让「上下文/日志/模块管理」等系统工具与
//     业务工具、未来 MCP/skill 工具并列可枚举。
// ============================================================

import type { PermissionLevel } from '../types'
import { hasPermission } from '../types'

/** 工具分类：可扩展（未来 mcp / skill 等新增分类自然并入）。 */
export type ToolCategory =
  | 'business' // 业务工具（oc_*，实现由 adapters 注入）
  | 'system' // 系统管理工具（agent_*，Kernel 提供）
  | 'context' // 上下文资产工具（context_*）
  | 'telemetry' // 日志读取（telemetry_*，admin）
  | 'module' // 模块评估/改造（module_*，admin）
  | (string & {})

/** JSON Schema 子集：参数定义（给 LLM 提示 + 运行时校验共用一份）。 */
export interface ToolPropertySchema {
  readonly type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null'
  readonly description?: string
  readonly enum?: readonly (string | number)[]
  readonly items?: ToolPropertySchema
}

export interface ToolParametersSchema {
  readonly type: 'object'
  readonly properties: Readonly<Record<string, ToolPropertySchema>>
  readonly required?: readonly string[]
  /** 允许承载其它 JSON Schema 扩展字段（additionalProperties 等）。 */
  readonly [key: string]: unknown
}

/** 一次模型发起的工具调用（与 gateway 协议无关的领域形状）。 */
export interface ToolInvocation {
  readonly id: string
  readonly name: string
  readonly input: unknown
}

/**
 * 工具执行上下文。
 * core 只定义最小字段；宿主/上层可扩展为带权限策略、MCP 通道、
 * 日志器等能力的子接口（组合注入，不修改 core）。
 */
export interface ToolContext {
  readonly agentId: string
  readonly spaceId: string
  /** 调用方 agent 的权限等级。 */
  readonly agentPermission: PermissionLevel
  readonly signal?: AbortSignal
  /** 本次调用 id（registry 执行时填充，供工具绑定自身 tool_call）。 */
  readonly callId?: string
}

/** 大输出引用（对接 ContextAssetPool 的 references 存储）。 */
export interface ToolReference {
  readonly uri: string
  readonly summary?: string
  readonly size?: number
}

export interface ToolResult {
  /** 进入 LLM 上下文的文本结果。 */
  readonly text: string
  /** 大输出引用（可空）。 */
  readonly references?: readonly ToolReference[]
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** 工具执行错误（判别联合，code-style §4.1）。 */
export type ToolError =
  | { readonly kind: 'tool_not_found'; readonly tool: string }
  | { readonly kind: 'tool_already_registered'; readonly tool: string }
  | { readonly kind: 'permission_denied'; readonly tool: string; readonly required: PermissionLevel; readonly actual: PermissionLevel }
  | { readonly kind: 'invalid_arguments'; readonly tool: string; readonly message: string }
  | { readonly kind: 'execution_failed'; readonly tool: string; readonly message: string; readonly cause?: unknown }

/** 工具调用审计记录（触发/反馈时由工具模块自动产生）。 */
export interface ToolRecord {
  readonly invocation: ToolInvocation
  /** 与调用关联的执行上下文（含 agentId）。 */
  readonly ctx: ToolContext
  /** called=已触发；success=执行成功；error=执行失败。 */
  readonly status: 'called' | 'success' | 'error'
  readonly result?: ToolResult
  readonly error?: ToolError
  readonly at: number
}

/** 工具能力（业务/系统工具统一形状）。 */
export interface ToolCapability {
  readonly id: string
  readonly description: string
  readonly parameters: ToolParametersSchema
  /** 执行所需最低权限（铁律 8 分级）。 */
  readonly permission: PermissionLevel
  readonly category?: ToolCategory
  /** 执行器（实现由适配层/Kernel 注入）。 */
  readonly execute: (input: unknown, ctx: ToolContext) => Promise<ToolResult> | ToolResult
  /** 可选自定义参数校验：返回错误信息或 undefined。 */
  readonly validate?: (input: unknown) => string | undefined
}

/** 权限策略（可插拔，默认分级比较）。 */
export interface PermissionResolver {
  readonly canExecute: (tool: ToolCapability, ctx: ToolContext) => boolean
}

/** 默认：工具 permission ≤ 调用方 agent 权限。 */
export class LevelPermissionResolver implements PermissionResolver {
  canExecute(tool: ToolCapability, ctx: ToolContext): boolean {
    return hasPermission(ctx.agentPermission, tool.permission)
  }
}

/** 执行生命周期钩子（横切扩展点：telemetry / 审计 / 限流 / MCP 网关）。 */
export interface ToolHooks {
  readonly onBeforeExecute?: (
    invocation: ToolInvocation,
    tool: ToolCapability,
    ctx: ToolContext,
  ) => Promise<void> | void
  readonly onAfterExecute?: (
    invocation: ToolInvocation,
    tool: ToolCapability,
    ctx: ToolContext,
    result: ToolResult,
  ) => Promise<void> | void
  readonly onError?: (
    invocation: ToolInvocation,
    tool: ToolCapability,
    ctx: ToolContext,
    error: ToolError,
  ) => Promise<void> | void
}
