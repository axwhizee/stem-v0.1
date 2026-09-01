// ============================================================
// core/gateway/ModelGateway.ts —— 网关接口（领域契约）
//
// 消费方（Runtime / 未来宿主）只依赖此接口，不接触 provider 实现。
// 实现可替换：openaiCompatible / FakeGateway / 未来 vendored llm。
// ============================================================

import type { LLMRequest, LLMEvent } from './types'

export interface ChatOptions {
  readonly signal?: AbortSignal
}

/** 模型网关：一次调用 = 一个 AsyncIterable 事件流。 */
export interface ModelGateway {
  readonly chat: (request: LLMRequest, options?: ChatOptions) => AsyncIterable<LLMEvent>
}
