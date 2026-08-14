// ============================================================
// core/tools/types.ts —— 工具系统领域类型（纯 TS，零平台依赖）
//
// 设计要点（可扩展性优先）：
//  1. ToolContext 是开放接口 —— 工具访问层、日志等宿主能力
//     以「字段注入」方式扩展，core 只定义最小必要字段；
//  2. 工具访问统一模型（权限融合进 tools）：每个工具声明访问键
//     （accessKey，如 read/edit/grep/glob/bash），agent 类 toolAccess
//     列表 + 祖先链 + session 用户批准决定 allow/ask/deny/ignore；
//     registry 执行时统一确认（evaluateAccess，分层取最严格）；
//  3. 执行生命周期暴露 ToolHooks（before/after/error），
//     供 telemetry、审计、限流等横切能力挂载；
//  4. kind（internal/shell/user）是工具固有属性：internal=core 系统工具
//     （默认 ignore 隐藏，显式 allow 才暴露），shell=宿主内置工具，
//     user=用户 `.stem/tool/` 提供的工具。
// ============================================================

/** 工具访问四态（权限融合进 tools 后的原子状态）。 */
export type ToolAccess = 'allow' | 'ask' | 'deny' | 'ignore'

/** 单条工具访问规则（访问键 → 动作）。 */
export interface ToolAccessRule {
  readonly key: string
  readonly action: ToolAccess
}

/** 工具访问规则集（数组；层内最后命中优先，层间取最严格）。 */
export type ToolAccessRules = readonly ToolAccessRule[]

/** 工具分类：可扩展（未来 mcp / skill 等新增分类自然并入）。 */
export type ToolCategory =
  | 'business' // 业务工具（oc_*，实现由 adapters 注入）
  | 'system' // 系统管理工具（agent_*，Kernel 提供）
  | 'context' // 上下文资产工具（context_*）
  | 'telemetry' // 日志读取（telemetry_*）
  | 'module' // 模块评估/改造（module_*）
  | (string & {})

/**
 * 工具来源（固有属性）：
 *   - internal = core 系统工具（agent_* / context_*，Kernel 提供）；
 *   - shell = 宿主内置工具（shell/tools/，如 read/write/edit/grep/glob）；
 *   - user = 用户提供的工具（`.stem/tool/`，经 init 注册）。
 */
export type ToolKind = 'internal' | 'shell' | 'user'

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
  /** 调用方 agent 的生效工具访问层（Runtime 从模板 toolAccess 生成；registry 用它统一确认）。 */
  readonly accessLayers?: readonly ToolAccessRules[]
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
  | { readonly kind: 'access_denied'; readonly tool: string; readonly accessKey: string }
  | { readonly kind: 'access_rejected'; readonly tool: string; readonly accessKey: string; readonly feedback?: string }
  | { readonly kind: 'invalid_arguments'; readonly tool: string; readonly message: string }
  | { readonly kind: 'execution_failed'; readonly tool: string; readonly message: string; readonly cause?: unknown }

// ---------- 工具访问确认（AccessManager 领域） ----------

/** 挂起中的访问确认请求（ask 时产生，交面板弹窗确认）。 */
export interface AccessRequest {
  readonly id: string
  /** 请求的访问键（工具 accessKey）。 */
  readonly accessKey: string
  /** 申请该访问的 agent id。 */
  readonly agentId: string
  /** 附带元数据（工具 id、参数摘要等，供面板展示）。 */
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly at: number
}

/** 用户回复（once=单次 / always=始终 / reject=拒绝）。 */
export type AccessReply = 'once' | 'always' | 'reject'

export interface AccessReplyInput {
  readonly requestId: string
  readonly reply: AccessReply
  /** reject 时可带反馈（告知 agent）。 */
  readonly message?: string
}

/** 访问断言输入。 */
export interface AccessAssertInput {
  readonly accessKey: string
  readonly agentId: string
  /** 该 agent 的完整访问层（kernel 合成：[全局, ...祖先链, agent 类]）。 */
  readonly layers?: readonly ToolAccessRules[]
  /** 该访问键的默认动作（internal 系统工具默认 'ignore'，其余 'ask'）。 */
  readonly defaultAccess?: ToolAccess
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** 访问错误（判别联合）。 */
export type AccessError =
  | { readonly kind: 'access_denied'; readonly accessKey: string; readonly agentId: string }
  | { readonly kind: 'access_rejected'; readonly accessKey: string; readonly requestId: string; readonly feedback?: string }
  | { readonly kind: 'access_request_not_found'; readonly requestId: string }

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
  /** 访问键（缺省 = 工具 id；多个工具可共享，如 edit/write → 'edit'）。 */
  readonly accessKey?: string
  /** 工具来源（固有属性）：internal=core 系统工具；shell=宿主内置；user=用户提供。 */
  readonly kind?: ToolKind
  readonly category?: ToolCategory
  /** 执行器（实现由适配层/Kernel 注入）。 */
  readonly execute: (input: unknown, ctx: ToolContext) => Promise<ToolResult> | ToolResult
  /** 可选自定义参数校验：返回错误信息或 undefined。 */
  readonly validate?: (input: unknown) => string | undefined
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
