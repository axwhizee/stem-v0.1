// ============================================================
// core/gateway/index.ts —— 唯一出口（只 re-export，不写逻辑）
//
// 外部只能从此 import，禁止深入内部文件（code-style §1.2）。
// ============================================================

export type { ModelGateway, ChatOptions } from './ModelGateway'
export type {
  ModelRef,
  ContentPart,
  TextPart,
  ToolCall,
  ChatMessage,
  ToolDefinition,
  LLMRequest,
  ToolCallEvent,
  UsageEvent,
  FinishEvent,
  LLMEvent,
  GatewayErrorKind,
} from './types'
export { GatewayError, isGatewayError, isAbortError } from './types'
export { createOpencodeGateway } from './providers/opencodeLlm'
export type { OpencodeGatewayConfig } from './providers/opencodeLlm'
export { FakeGateway, textEvents, abortError } from './FakeGateway'
export type { FakeGatewayHandler } from './FakeGateway'
