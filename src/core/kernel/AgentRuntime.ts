// ============================================================
// core/kernel/AgentRuntime.ts —— 单实例运行循环
//
// run(agentId, input)：
//   instance → template(AgentClass) → 组装 ContextProfile/历史
//   → ModelGateway.chat 流式 → 累加器 → 回写历史/计数
// while 循环有显式退出条件（maxSteps / 无 tool_call / finish），
// 工具执行器（Task 1.5）后续在此接入。core 零平台依赖。
// ============================================================

import type { ModelGateway } from '../gateway'
import type { ChatMessage, LLMEvent, LLMRequest, ModelRef, ToolCallEvent, UsageEvent } from '../gateway'
import type { AgentTemplateRegistry } from './AgentTemplateRegistry'
import type { AgentInstanceManager } from './AgentInstanceManager'
import type { AgentID } from './types'

export interface AgentRuntimeDeps {
  readonly gateway: ModelGateway
  readonly instances: AgentInstanceManager
  readonly templates: AgentTemplateRegistry
  /** 模板未配置 model 时使用的默认模型。 */
  readonly defaultModel: ModelRef
  /** 最大循环步数（默认 1：本阶段无工具执行器，单轮即止）。 */
  readonly maxSteps?: number
  /** 成本估算（默认不估算，接入定价后注入）。 */
  readonly estimateCost?: (usage: UsageEvent | undefined) => number
}

export interface RuntimeRunOptions {
  /** 每个流式事件透传（shell/UI 实时展示用）。 */
  readonly onEvent?: (event: LLMEvent) => void
}

/** 一次 run 的汇总结果。 */
export interface ChatResult {
  readonly agentId: AgentID
  readonly text: string
  readonly reasoning: string
  readonly toolCalls: readonly ToolCallEvent[]
  readonly usage: UsageEvent | undefined
  readonly finishReason: 'stop' | 'tool_calls' | 'length'
  readonly turnCount: number
}

export interface AgentRuntime {
  readonly run: (agentId: AgentID, input: string, opts?: RuntimeRunOptions) => Promise<ChatResult>
}

export class DefaultAgentRuntime implements AgentRuntime {
  private readonly maxSteps: number
  private readonly estimateCost: (usage: UsageEvent | undefined) => number

  constructor(private readonly deps: AgentRuntimeDeps) {
    this.maxSteps = deps.maxSteps ?? 1
    this.estimateCost = deps.estimateCost ?? (() => 0)
  }

  async run(agentId: AgentID, input: string, opts?: RuntimeRunOptions): Promise<ChatResult> {
    const instances = this.deps.instances
    const instance = await instances.get(agentId)
    const template = await this.deps.templates.get(instance.classRef)

    await instances.updateStatus(agentId, 'running')
    try {
      const contextProfile = template.contextProfile
      const system = contextProfile?.systemPrompt ?? template.systemPrompt
      const model = template.model ?? this.deps.defaultModel

      // 跨轮历史累积区：从实例历史起步（可被 contextProfile.includeHistory 关闭），本轮新增在循环内追加。
      let history: ChatMessage[] = contextProfile?.includeHistory === false ? [] : [...instance.history]
      let userMessage: ChatMessage = { role: 'user', content: input }

      const textParts: string[] = []
      const reasoningParts: string[] = []
      const toolCalls: ToolCallEvent[] = []
      let usage: UsageEvent | undefined
      let finishReason: ChatResult['finishReason'] = 'stop'
      let steps = 0

      while (steps < this.maxSteps) {
        const request: LLMRequest = { model, system, messages: [...history, userMessage] }
        const events = this.deps.gateway.chat(request)

        for await (const event of events) {
          switch (event.type) {
            case 'text-delta':
              textParts.push(event.text)
              break
            case 'reasoning-delta':
              reasoningParts.push(event.text)
              break
            case 'tool-call':
              toolCalls.push(event)
              break
            case 'usage':
              usage = event
              break
            case 'finish':
              finishReason = event.reason
              break
          }
          opts?.onEvent?.(event)
        }

        steps++
        history = [...history, userMessage, { role: 'assistant', content: textParts.join('') }]

        // 显式退出条件：无 tool_call 结束本轮；后续接入工具执行器后再续轮。
        if (finishReason !== 'tool_calls' || steps >= this.maxSteps) break
        // Task 1.5：工具执行器在此处执行 toolCalls → toolResult → 续 userMessage。
        break
      }

      // 回写实例历史（仅追加本轮新增）与计数
      instance.history.push(...history.slice(instance.history.length))
      instance.turnCount += 1
      instance.totalCost += this.estimateCost(usage)

      return {
        agentId,
        text: textParts.join(''),
        reasoning: reasoningParts.join(''),
        toolCalls,
        usage,
        finishReason,
        turnCount: steps,
      }
    } finally {
      await instances.updateStatus(agentId, 'idle')
    }
  }
}
