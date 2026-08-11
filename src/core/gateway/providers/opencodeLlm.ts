// ============================================================
// core/gateway/providers/opencodeLlm.ts —— opencode 单点实现（★）
//
// 本文件是「opencode 隔离」的唯一落点（decisions D5）：
//   - 认证：OPENCODE_API_KEY（Bearer）/ config.apiKey
//   - 协议：OpenAI 兼容 /zen/v1/chat/completions，SSE 流式
//   - 端点配置驱动，不硬编码（decisions 风险表）
// 对外只暴露 ModelGateway 接口，不泄漏任何 opencode 概念。
// 参考：opencode core/src/plugin/provider/opencode.ts（认证）、
//       llm/src/provider-error.ts（context overflow 判定）、
//       opencode src/provider/error.ts（错误分类）。
// ============================================================

import type { ModelGateway, ChatOptions } from '../ModelGateway'
import type { ChatMessage, LLMRequest, LLMEvent, ToolCall, ToolDefinition, UsageEvent } from '../types'
import { GatewayError, type ContentPart } from '../types'

// 已验证的真实端点（opencode-go / OpenCode Go）：
//   host https://opencode.ai, path /zen/go/v1/chat/completions
// （decisions 中记录的 api.opencode.ai/zen/v1/* 已随服务端演进失效，
//   保持「配置驱动、不硬编码」原则，默认值仅作兜底。）
export const DEFAULT_SERVER = 'https://opencode.ai'
export const DEFAULT_PATH = '/zen/go/v1/chat/completions'
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000

export interface OpencodeGatewayConfig {
  /** 服务端基址（默认 https://api.opencode.ai）。 */
  readonly server?: string
  /** 协议路径（默认 /zen/v1/chat/completions）。 */
  readonly path?: string
  /** API key（默认取 OPENCODE_API_KEY）。 */
  readonly apiKey?: string
  /** 首包超时（毫秒）。 */
  readonly requestTimeoutMs?: number
  /** 可注入 fetch（测试用）。 */
  readonly fetch?: typeof fetch
}

/** 构造 opencode 网关。缺少凭据时同步抛出 GatewayError(auth_missing)。 */
export function createOpencodeGateway(config: OpencodeGatewayConfig = {}): ModelGateway {
  const server = (config.server ?? DEFAULT_SERVER).replace(/\/+$/, '')
  const path = config.path ?? DEFAULT_PATH
  const apiKey = config.apiKey ?? process.env.OPENCODE_API_KEY
  const httpFetch = config.fetch ?? globalThis.fetch
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

  if (!apiKey) {
    throw new GatewayError({
      kind: 'auth_missing',
      message: 'Missing OpenCode API key: set OPENCODE_API_KEY or pass config.apiKey',
    })
  }

  const endpoint = `${server}${path}`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    Accept: 'text/event-stream',
  }

  async function* chat(request: LLMRequest, options?: ChatOptions): AsyncIterable<LLMEvent> {
    const ctl = new AbortController()
    let onAbort: (() => void) | undefined
    const external = options?.signal

    if (external) {
      if (external.aborted) {
        ctl.abort(external.reason)
      } else {
        onAbort = () => ctl.abort(external.reason)
        external.addEventListener('abort', onAbort, { once: true })
      }
    }

    // 首包超时保护（参考 opencode HeaderTimeoutError）。
    const timeoutId = setTimeout(() => ctl.abort(), requestTimeoutMs)

    try {
      const response = await httpFetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildBody(request)),
        signal: ctl.signal,
      })
      if (!response.ok) {
        throw await toGatewayError(response)
      }
      if (!response.body) {
        throw new GatewayError({ kind: 'invalid_response', message: 'Response has no body stream' })
      }
      yield* parseSse(response.body, ctl.signal)
    } catch (error) {
      throw toGatewayErrorFromCause(error, ctl.signal)
    } finally {
      clearTimeout(timeoutId)
      if (external && onAbort) external.removeEventListener('abort', onAbort)
      ctl.abort()
    }
  }

  return { chat }
}

// ---------- 请求体构造 ----------

function buildBody(request: LLMRequest): Record<string, unknown> {
  const messages: unknown[] = []
  if (request.system) messages.push({ role: 'system', content: request.system })
  for (const message of request.messages) messages.push(toApiMessage(message))

  const body: Record<string, unknown> = {
    model: request.model.id,
    messages,
    stream: true,
    // 流式下显式要求返回 usage（SSE 末尾事件）。
    stream_options: { include_usage: true },
  }
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map(toApiTool)
  }
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
  if (request.temperature !== undefined) body.temperature = request.temperature
  return body
}

function toApiTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }
}

function toApiMessage(message: ChatMessage): Record<string, unknown> {
  const result: Record<string, unknown> = { role: message.role }
  result.content = Array.isArray(message.content) ? message.content.map(toApiContentPart) : message.content

  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    result.tool_calls = message.toolCalls.map((tc, index) => ({
      id: tc.id,
      type: 'function',
      index,
      function: { name: tc.name, arguments: tc.arguments },
    }))
  }
  if (message.role === 'tool' && message.toolCallId !== undefined) {
    result.tool_call_id = message.toolCallId
  }
  return result
}

function toApiContentPart(part: ContentPart): Record<string, unknown> {
  return { type: part.type, text: part.text }
}

// ---------- SSE 解析 ----------

interface PendingToolCall {
  id: string | undefined
  name: string
  argsBuffer: string
}

async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<LLMEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const pending = new Map<number, PendingToolCall>()
  let buffer = ''
  let emittedUsage = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let newlineIndex: number
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue

        const data = trimmed.slice('data:'.length).trim()
        if (data === '[DONE]') continue

        let chunk: unknown
        try {
          chunk = JSON.parse(data)
        } catch {
          throw new GatewayError({ kind: 'invalid_response', message: `Malformed SSE payload: ${data}` })
        }
        yield* handleChunk(chunk, pending, () => {
          emittedUsage = true
        })
      }
    }
  } catch (error) {
    if (error instanceof GatewayError) throw error
    throw new GatewayError({ kind: 'request_failed', message: 'Stream read failed', cause: error })
  } finally {
    reader.releaseLock()
  }
}

function handleChunk(
  chunk: unknown,
  pending: Map<number, PendingToolCall>,
  markUsage: () => void,
): LLMEvent[] {
  const events: LLMEvent[] = []
  if (!isRecord(chunk)) return events

  // 服务端/网关错误事件（OpenAI 兼容流内 error 字段）。
  if (chunk.error !== undefined) {
    throw errorFromBody(chunk.error, 'stream_error')
  }

  const choices = Array.isArray(chunk.choices) ? chunk.choices : []
  const choice = choices[0]
  if (isRecord(choice)) {
    const delta = isRecord(choice.delta) ? choice.delta : {}
    if (typeof delta.content === 'string' && delta.content !== '') {
      events.push({ type: 'text-delta', text: delta.content })
    }
    // DeepSeek/部分网关用 reasoning_content；部分用 delta.reasoning。
    const reasoning = delta.reasoning_content ?? (isRecord(delta.reasoning) ? delta.reasoning.content : delta.reasoning)
    if (typeof reasoning === 'string' && reasoning !== '') {
      events.push({ type: 'reasoning-delta', text: reasoning })
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        if (!isRecord(tc)) continue
        const index = typeof tc.index === 'number' ? tc.index : pending.size
        const existing = pending.get(index) ?? { id: undefined, name: '', argsBuffer: '' }
        if (typeof tc.id === 'string') existing.id = tc.id
        const fn = isRecord(tc.function) ? tc.function : {}
        if (typeof fn.name === 'string') existing.name += fn.name
        if (typeof fn.arguments === 'string') existing.argsBuffer += fn.arguments
        pending.set(index, existing)
      }
    }
    if (typeof choice.finish_reason === 'string') {
      const reason = choice.finish_reason
      if (reason === 'tool_calls' && pending.size > 0) {
        for (const call of pending.values()) {
          if (!call.id) continue
          events.push({ type: 'tool-call', id: call.id, name: call.name, input: parseToolInput(call.argsBuffer) })
        }
        pending.clear()
      }
      events.push({ type: 'finish', reason: normalizeFinishReason(reason) })
    }
  }

  // usage 通常在最后一个 chunk（choices 为空）返回。
  if (isRecord(chunk.usage)) {
    events.push(usageEvent(chunk.usage))
    markUsage()
  }
  return events
}

function usageEvent(usage: Record<string, unknown>): LLMEvent {
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {}
  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {}
  const cached =
    numberOrZero(details.cached_tokens) +
    numberOrZero(inputDetails.cache_read_input_tokens) +
    numberOrZero(usage.cache_read_input_tokens)
  const inputTokens = numberOrZero(usage.prompt_tokens) || numberOrZero(usage.input_tokens)
  const outputTokens = numberOrZero(usage.completion_tokens) || numberOrZero(usage.output_tokens)
  const cacheRead = cached > 0 ? { cacheReadTokens: cached } : {}
  const cacheWrite =
    numberOrZero(inputDetails.cache_creation_input_tokens) + numberOrZero(usage.cache_write_input_tokens)
  const event: UsageEvent = {
    type: 'usage',
    inputTokens,
    outputTokens,
    ...cacheRead,
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
  }
  return event
}

type FinishReason = Extract<LLMEvent, { type: 'finish' }>['reason']

function normalizeFinishReason(reason: string): FinishReason {
  if (reason === 'tool_calls') return 'tool_calls'
  if (reason === 'length' || reason === 'max_tokens') return 'length'
  return 'stop'
}

function parseToolInput(raw: string): unknown {
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

// ---------- 错误分类 ----------

/** 判定是否上下文溢出（模式集合参考 opencode llm/provider-error.ts）。 */
const CONTEXT_OVERFLOW_PATTERNS: RegExp[] = [
  /prompt is too long/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length/i,
  /input token count.*exceeds the maximum/i,
  /tokens in request more than max tokens allowed/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /context[_ ]length[_ ]exceeded/i,
  /request entity too large/i,
  /context length is only \d+ tokens/i,
  /model_context_window_exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
]
const CONTEXT_EXCLUSIONS: RegExp[] = [/^(throttling error|service unavailable):/i, /rate limit/i, /too many requests/i]

function isContextOverflow(message: string): boolean {
  return (
    !CONTEXT_EXCLUSIONS.some((p) => p.test(message)) && CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(message))
  )
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function errorMessageFromBody(body: unknown): string | undefined {
  if (typeof body === 'string') return body
  if (isRecord(body)) {
    if (typeof body.message === 'string') return body.message
    if (isRecord(body.error)) {
      if (typeof body.error.message === 'string') return body.error.message
      if (typeof body.error.code === 'string') return body.error.code
    }
    if (typeof body.code === 'string') return body.code
  }
  return undefined
}

function errorFromBody(body: unknown, source: string): GatewayError {
  const message = errorMessageFromBody(body) ?? `Provider error from ${source}`
  if (isRecord(body) && isRecord(body.error)) {
    const code = typeof body.error.code === 'string' ? body.error.code : ''
    if (code === 'context_length_exceeded' || isContextOverflow(message)) {
      return new GatewayError({ kind: 'context_overflow', message })
    }
  }
  if (isContextOverflow(message)) {
    return new GatewayError({ kind: 'context_overflow', message })
  }
  return new GatewayError({ kind: 'api_error', message })
}

async function toGatewayError(response: Response): Promise<GatewayError> {
  const raw = await response.text().catch(() => '')
  let body: unknown = raw
  try {
    body = JSON.parse(raw)
  } catch {
    // 非 JSON（HTML 错误页等），保留原文。
  }
  const message = errorMessageFromBody(body) ?? `HTTP ${response.status} ${response.statusText}`
  const errorCode = errorCodeFromBody(body)
  if (response.status === 413 || errorCode === 'context_length_exceeded' || isContextOverflow(message)) {
    return new GatewayError({
      kind: 'context_overflow',
      message,
      statusCode: response.status,
    })
  }
  return new GatewayError({
    kind: 'api_error',
    message,
    retryable: isRetryableStatus(response.status),
    statusCode: response.status,
  })
}

function errorCodeFromBody(body: unknown): string | undefined {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.code === 'string') return body.error.code
  if (isRecord(body) && typeof body.code === 'string') return body.code
  return undefined
}

function toGatewayErrorFromCause(error: unknown, signal: AbortSignal): GatewayError {
  if (error instanceof GatewayError) return error
  if (signal.aborted) {
    return new GatewayError({ kind: 'request_failed', message: 'Request aborted (timeout or user cancel)', cause: error })
  }
  return new GatewayError({ kind: 'request_failed', message: 'Request failed', cause: error })
}
