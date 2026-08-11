// ============================================================
// core/kernel/AgentRuntime.ts —— 被动驱动运行循环
//
// 由邮局"送信"回调驱动（kernel 注册 onDelivery → processDelivery）：
//   收到组装好的完整上下文 → status=thinking → LLM → 工具轮（并行）
//   → 每轮 assistant 消息自动复制到邮局历史
//   → 最终纯文本回复加发送者戳 `<sender id="xxx">` → 寄信给创建者
//   → status=cooldown（邮局倒计时；无信则 onHold → status=hold）
//
// agent 全程被动：不主动轮询，不发起对话。core 零平台依赖。
// ============================================================

import type { ModelGateway } from '../gateway'
import type { ChatMessage, LLMEvent, LLMRequest, ModelRef, ToolCallEvent, UsageEvent } from '../gateway'
import type { MessageBus } from '../bus'
import type { AgentDelivery, ContextManager } from '../context'
import type { ToolCapabilityRegistry, ToolContext } from '../tools'
import type { AgentTemplateRegistry } from './AgentTemplateRegistry'
import type { AgentInstanceManager } from './AgentInstanceManager'
import type { AgentClass, AgentID } from './types'
import { makeAgentID } from './types'

export interface AgentRuntimeDeps {
  readonly gateway: ModelGateway
  readonly instances: AgentInstanceManager
  readonly templates: AgentTemplateRegistry
  readonly contextManager: ContextManager
  readonly bus: MessageBus
  /** 工具注册表（缺省不启用工具轮）。 */
  readonly tools?: ToolCapabilityRegistry
  /** 模板未配置 model 时使用的默认模型。 */
  readonly defaultModel: ModelRef
  /** 最大循环步数（含工具轮；默认 5）。 */
  readonly maxSteps?: number
  readonly estimateCost?: (usage: UsageEvent | undefined) => number
  /** 流式事件全局透传（shell 面板显示用）。 */
  readonly onEvent?: (agentId: AgentID, event: LLMEvent) => void
}

export interface AgentRuntime {
  /** 邮局送信回调（kernel 装配时注册）。 */
  readonly processDelivery: (delivery: AgentDelivery) => Promise<void>
  /** 邮局倒计时结束无信 → hold。 */
  readonly notifyHold: (agentId: AgentID) => Promise<void>
}

export class DefaultAgentRuntime implements AgentRuntime {
  private readonly maxSteps: number
  private readonly estimateCost: (usage: UsageEvent | undefined) => number

  constructor(private readonly deps: AgentRuntimeDeps) {
    this.maxSteps = deps.maxSteps ?? 5
    this.estimateCost = deps.estimateCost ?? (() => 0)
  }

  async processDelivery(delivery: AgentDelivery): Promise<void> {
    const instances = this.deps.instances
    const instance = await instances.get(makeAgentID(delivery.agentId))
    const template = await this.deps.templates.get(instance.classRef)
    const model = template.model ?? this.deps.defaultModel

    await instances.updateStatus(instance.id, 'thinking')

    const allText: string[] = []
    const allReasoning: string[] = []
    let usage: UsageEvent | undefined
    let finishReason: 'stop' | 'tool_calls' | 'length' = 'stop'
    let session: ChatMessage[] = [...delivery.messages]
    const tools = this.enabledTools(template)
    let steps = 0

    while (steps < this.maxSteps) {
      const roundText: string[] = []
      const roundReasoning: string[] = []
      const toolCalls: ToolCallEvent[] = []
      let roundUsage: UsageEvent | undefined
      let roundFinish: 'stop' | 'tool_calls' | 'length' = 'stop'

      const request: LLMRequest = { model, system: delivery.system, messages: session, tools }
      for await (const event of this.deps.gateway.chat(request)) {
        switch (event.type) {
          case 'text-delta':
            roundText.push(event.text)
            break
          case 'reasoning-delta':
            roundReasoning.push(event.text)
            break
          case 'tool-call':
            toolCalls.push(event)
            break
          case 'usage':
            roundUsage = event
            break
          case 'finish':
            roundFinish = event.reason
            break
        }
        this.deps.onEvent?.(instance.id, event)
      }

      steps++
      allText.push(...roundText)
      allReasoning.push(...roundReasoning)
      usage = mergeUsage(usage, roundUsage)
      finishReason = roundFinish

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: roundText.join(''),
        toolCalls: toolCalls.length > 0 ? toolCalls.map(toProtocolToolCall) : undefined,
      }
      session = [...session, assistantMessage]
      // 自动复制 assistant 消息到邮局历史。
      await this.deps.contextManager.appendHistory(instance.id, assistantMessage)

      // 显式退出条件：无工具调用 → 结束会话。
      if (roundFinish !== 'tool_calls' || toolCalls.length === 0 || !this.deps.tools) break

      // 工具轮：并行执行（协议原生支持多个 tool_call），结果按调用顺序回填。
      const ctx: ToolContext = {
        agentId: instance.id,
        spaceId: instance.spaceId,
        agentPermission: template.permission,
      }
      const results = await Promise.all(
        toolCalls.map(async (call): Promise<ChatMessage> => {
          try {
            const result = await this.deps.tools!.execute({ id: call.id, name: call.name, input: call.input }, ctx)
            return { role: 'tool', content: result.text, toolCallId: call.id }
          } catch (cause) {
            const error = cause as { kind?: string; message?: string }
            const message =
              typeof error.kind === 'string' && typeof error.message === 'string'
                ? `[ToolError ${error.kind}] ${error.message}`
                : '[ToolError execution_failed] 工具执行失败'
            return { role: 'tool', content: message, toolCallId: call.id }
          }
        }),
      )
      session = [...session, ...results]
    }

    // 统计与状态
    instance.turnCount += 1
    instance.totalCost += this.estimateCost(usage)
    await instances.updateStatus(instance.id, 'cooldown')

    // 最终回复：自动加发送者戳 → 寄信给创建者。
    const finalText = allText.join('')
    const stamped = `<sender id="${instance.id}">${finalText}</sender>`
    await this.deps.bus.send({
      kind: 'result',
      from: instance.id,
      to: instance.creatorId,
      payload: stamped,
      at: Date.now(),
    })
  }

  async notifyHold(agentId: AgentID): Promise<void> {
    await this.deps.instances.updateStatus(agentId, 'hold')
  }

  /** 物化本轮 LLM 工具集：注册表按模板权限物化 ∩ 模板工具白名单。 */
  private enabledTools(template: AgentClass) {
    if (!this.deps.tools) return undefined
    const available = this.deps.tools.materialize(template.permission)
    // template.tools 为 undefined → 全部权限内工具；显式数组（含空）→ 白名单（空=无工具）。
    if (template.tools === undefined) return available
    const allowed = new Set(template.tools.map((t) => t.id))
    return available.filter((tool) => allowed.has(tool.name))
  }
}

function toProtocolToolCall(call: ToolCallEvent): { id: string; name: string; arguments: string } {
  return {
    id: call.id,
    name: call.name,
    arguments: typeof call.input === 'string' ? call.input : JSON.stringify(call.input),
  }
}

function mergeUsage(a: UsageEvent | undefined, b: UsageEvent | undefined): UsageEvent | undefined {
  if (!b) return a
  if (!a) return b
  return {
    type: 'usage',
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined
      ? { cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0) }
      : {}),
    ...(a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0) }
      : {}),
  }
}
