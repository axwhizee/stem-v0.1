// ============================================================
// core/gateway/index.ts —— 唯一出口（只 re-export，不写逻辑）
//
// 外部只能从此 import，禁止深入内部文件（code-style §1.2）。
// ============================================================

export type { ModelGateway, ChatOptions } from './ModelGateway'
export type {
  ModelRef,
  EffortLevel,
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
export { GatewayError, isGatewayError, isAbortError, parseModelRef } from './types'
export { createOpenAiCompatibleGateway } from './providers/openaiCompatible'
export type { OpenAiCompatibleConfig } from './providers/openaiCompatible'
export { FakeGateway, textEvents, abortError } from './FakeGateway'
export type { FakeGatewayHandler } from './FakeGateway'
