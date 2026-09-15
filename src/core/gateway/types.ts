// ============================================================
// core/gateway/types.ts —— 领域类型（纯 TS，零平台依赖）
//
// 判别联合事件 / DTO / 错误，作为 ModelGateway 契约的数据层。
// 不 import 'vscode'，不 import opencode —— 与宿主完全解耦。
// ============================================================

/** 模型引用（provider + 模型 id）。 */
export interface ModelRef {
  readonly provider: string
  readonly id: string
}

/** 模型思考强度（写 reasoning_effort；缺省 none = 压延迟）。 */
export type EffortLevel = 'none' | 'low' | 'medium' | 'high'

/**
 * `提供商/模型` 字符串 → ModelRef（两段皆非空；严格格式，无归属不受理）。
 * 单一解析点：tools 工具参数 / kernel 类字段归一 / webui 写口共用。
 */
export function parseModelRef(value: string): ModelRef | undefined {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) }
}

/** 文本内容块。 */
export interface TextPart {
  readonly type: 'text'
  readonly text: string
}

/** 消息内容块（阶段 1 仅文本，图片/文件等后续扩展）。 */
export type ContentPart = TextPart

/** 一次模型发起的工具调用（OpenAI 协议形状：arguments 为 JSON 字符串）。 */
export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: string
}

/** 对话消息（OpenAI 兼容形状）。 */
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string | readonly ContentPart[]
  /** 仅 role=assistant：本轮模型发出的工具调用。 */
  readonly toolCalls?: readonly ToolCall[]
  /** 仅 role=tool：对应的工具调用 id。 */
  readonly toolCallId?: string
}

/** 工具定义（JSON Schema 形状，透传给协议层）。 */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

/** 一次 LLM 请求。 */
export interface LLMRequest {
  readonly model: ModelRef
  readonly system?: string
  readonly messages: readonly ChatMessage[]
  readonly tools?: readonly ToolDefinition[]
  readonly maxTokens?: number
  readonly temperature?: number
  /** 思考强度（provider 层映射 reasoning_effort）。 */
  readonly reasoningEffort?: EffortLevel
}

/** 工具调用事件（input 已解析为 JSON）。 */
export interface ToolCallEvent {
  readonly type: 'tool-call'
  readonly id: string
  readonly name: string
  readonly input: unknown
}

/** 用量事件（由服务端返回，客户端无需估算）。 */
export interface UsageEvent {
  readonly type: 'usage'
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

/** 结束事件。 */
export interface FinishEvent {
  readonly type: 'finish'
  readonly reason: 'stop' | 'tool_calls' | 'length'
}

/** 流式事件判别联合。 */
export type LLMEvent =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly text: string }
  | ToolCallEvent
  | UsageEvent
  | FinishEvent

/** 网关错误分类。 */
export type GatewayErrorKind =
  | 'auth_missing'
  | 'context_overflow'
  | 'api_error'
  | 'invalid_response'
  | 'request_failed'
  /** 路由/配置类硬错（S6 R1）：provider 未注册、key_env 未命中未接通、baseUrl 无效。 */
  | 'provider_unwired'
  /** 模型不在 provider 启用白名单内（config providers.<name>.models）。 */
  | 'model_not_allowed'

/** 统一网关错误：不 throw 字符串，判别联合错误（code-style §4.1）。 */
export class GatewayError extends Error {
  readonly kind: GatewayErrorKind
  readonly retryable: boolean
  readonly statusCode?: number

  constructor(input: {
    kind: GatewayErrorKind
    message: string
    retryable?: boolean
    statusCode?: number
    cause?: unknown
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause })
    this.name = 'GatewayError'
    this.kind = input.kind
    this.retryable = input.retryable ?? false
    if (input.statusCode !== undefined) this.statusCode = input.statusCode
  }
}

/** 类型守卫。 */
export function isGatewayError(value: unknown): value is GatewayError {
  return value instanceof GatewayError
}

/** 判定中断（用户/进程主动 abort，或首包超时触发的 AbortError）。 */
export function isAbortError(value: unknown): value is Error & { readonly name: 'AbortError' } {
  return (
    (value instanceof Error && value.name === 'AbortError') ||
    (value instanceof DOMException && value.name === 'AbortError')
  )
}
