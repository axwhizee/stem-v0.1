// ============================================================
// core/context/ContextAssembler.ts —— 上下文组装器
//
// 组装发生在"送信时刻"（倒计时终点）。经典组装模式把邮局累积的
// 历史（assistant/tool）与信件（user_prompt）组装为完整 messages。
// 组装器可替换 —— 为未来深度定制上下文预留扩展位。
// ============================================================

import type { ChatMessage, ToolDefinition } from '../gateway'

export interface AssembleInput {
  readonly systemPrompt: string
  /** 历史上下文（含已并入的信件）。 */
  readonly context: readonly ChatMessage[]
  readonly tools?: readonly ToolDefinition[]
}

export interface AssembleResult {
  readonly system: string
  readonly messages: readonly ChatMessage[]
  readonly tools?: readonly ToolDefinition[]
}

export interface ContextAssembler {
  readonly assemble: (input: AssembleInput) => AssembleResult
}

/** 经典组装模式（默认）：system + context 直接作为 messages。 */
export class ClassicContextAssembler implements ContextAssembler {
  assemble(input: AssembleInput): AssembleResult {
    return {
      system: input.systemPrompt,
      messages: [...input.context],
      tools: input.tools,
    }
  }
}
