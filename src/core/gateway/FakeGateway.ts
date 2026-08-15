// ============================================================
// core/gateway/FakeGateway.ts —— 测试替身（无网络）
//
// 用于单元测试与无 UI 冒烟：按 handler 脚本逐条产出事件，
// 记录所有请求以便断言。实现 ModelGateway 接口，与真实网关可互换。
// 支持中断模拟：ChatOptions.signal 中断时抛 AbortError。
// ============================================================

import type { ModelGateway } from './ModelGateway'
import type { ChatOptions } from './ModelGateway'
import type { LLMEvent, LLMRequest } from './types'

/** 构造一段纯文本回复的事件流（含 usage + finish）。 */
export function textEvents(text: string, usage?: { inputTokens?: number; outputTokens?: number }): LLMEvent[] {
  const events: LLMEvent[] = []
  const chunk = 8
  for (let i = 0; i < text.length; i += chunk) {
    events.push({ type: 'text-delta', text: text.slice(i, i + chunk) })
  }
  events.push({ type: 'usage', inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 })
  events.push({ type: 'finish', reason: 'stop' })
  return events
}

export type FakeGatewayHandler = (
  request: LLMRequest,
  options?: ChatOptions,
) => Iterable<LLMEvent> | AsyncIterable<LLMEvent>

export class FakeGateway implements ModelGateway {
  readonly requests: LLMRequest[] = []

  constructor(private readonly handler: FakeGatewayHandler) {}

  async *chat(request: LLMRequest, options?: ChatOptions): AsyncIterable<LLMEvent> {
    this.requests.push(request)
    // 中断模拟：signal 已中断 → 立即抛 AbortError。
    if (options?.signal?.aborted) throw abortError()
    const result = this.handler(request, options)
    if (Symbol.asyncIterator in Object(result)) {
      yield* result as AsyncIterable<LLMEvent>
    } else {
      for (const event of result as Iterable<LLMEvent>) yield event
    }
    // 流中中断：逐条产出后检查 signal，已中断 → 抛 AbortError。
    if (options?.signal?.aborted) throw abortError()
  }
}

/** 构造 AbortError（供测试模拟中断时与 isAbortError 匹配）。 */
export function abortError(): Error & { readonly name: 'AbortError' } {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error as Error & { readonly name: 'AbortError' }
}
