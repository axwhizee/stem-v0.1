// ============================================================
// core/kernel/Runtime.ts —— 被动驱动运行循环
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
import { isAbortError, isGatewayError } from '../gateway'
import type { LogSink } from '../logging'
import type { AgentDelivery, ContextManager, Repository } from '../context'
import type { ToolCapabilityRegistry, ToolContext } from '../tools'
import type { InstanceManager } from './InstanceManager'
import type { AgentID, AgentStatus } from './types'
import { makeAgentID } from './types'

export interface RuntimeDeps {
  readonly gateway: ModelGateway
  readonly instances: InstanceManager
  readonly contextManager: ContextManager
  /** 上下文仓库（assistant/tool 消息入库）。 */
  readonly repository: Repository
  /** 工具注册表（缺省不启用工具轮）。 */
  readonly tools?: ToolCapabilityRegistry
  /**
   * 模型解析端口（S6/R6：族谱树四级律——显式 > 类基因 > 父继承 > 家学；
   * kernel 接 lineage.modelOf。undefined = 全链无锚，见 processDelivery 防御）。
   */
  readonly resolveModel: (agentId: AgentID) => ModelRef | undefined
  /** 最大循环步数（含工具轮；默认 5）。 */
  readonly maxSteps?: number
  readonly estimateCost?: (usage: UsageEvent | undefined) => number
  /** 流式事件全局透传（shell 面板显示用）。 */
  readonly onEvent?: (agentId: AgentID, event: LLMEvent) => void
  /** 状态变化通知（agentId, from, to）。 */
  readonly onStatus?: (agentId: AgentID, from: AgentStatus, to: AgentStatus) => void
  /** 日志出口（组合根注入 → core/logging）。 */
  readonly onLog?: LogSink
}

export interface Runtime {
  /** 邮局送信回调（kernel 装配时注册）。 */
  readonly processDelivery: (delivery: AgentDelivery) => Promise<void>
  /** 邮局倒计时结束无信 → hold。 */
  readonly notifyHold: (agentId: AgentID) => Promise<void>
  /** 中断指定 agent 的当前轮（触发 AbortController.abort）。 */
  readonly abort: (agentId: AgentID) => void
  /** 中断所有活跃 agent（进程优雅收尾用）。 */
  readonly abortAll: () => void
  /** 当前活跃（thinking/进行中）的 agent id 列表。 */
  readonly activeAgents: () => readonly AgentID[]
}

/** 中断后收尾标记（消息闭合：避免出现"assistant 后直接接 user"的非法消息序列）。 */
export const INTERRUPTED_MARKER = '<interrupted>'

export class DefaultRuntime implements Runtime {
  private readonly maxSteps: number
  private readonly estimateCost: (usage: UsageEvent | undefined) => number
  /** 各 agent 当前轮的中断控制器（进程/用户中断入口）。 */
  private readonly controllers = new Map<AgentID, AbortController>()

  constructor(private readonly deps: RuntimeDeps) {
    this.maxSteps = deps.maxSteps ?? 5
    this.estimateCost = deps.estimateCost ?? (() => 0)
  }

  abort(agentId: AgentID): void {
    const ctl = this.controllers.get(agentId)
    if (ctl && !ctl.signal.aborted) ctl.abort()
  }

  abortAll(): void {
    for (const ctl of this.controllers.values()) {
      if (!ctl.signal.aborted) ctl.abort()
    }
  }

  activeAgents(): readonly AgentID[] {
    return [...this.controllers.keys()]
  }

  async processDelivery(delivery: AgentDelivery): Promise<void> {
    const instances = this.deps.instances
    const instance = await instances.get(makeAgentID(delivery.agentId))
    // S6/R6：本轮模型 = 族谱树四级律快照（setModel 下轮送信自然生效）。
    const model = this.deps.resolveModel(instance.id)
    if (model === undefined) {
      // 全链无锚 = 配置事故（boot 硬校验保证正常不发生），中断本轮并点名修复处。
      this.deps.onLog?.log({
        type: 'kernel.instance.interrupted',
        at: Date.now(),
        agentId: instance.id,
        aborted: false,
        errorKind: 'model_unresolved',
        message: '族谱模型解析链无锚（检查 config.user.model / 类 model / set_model）',
      })
      await this.setStatus(instance, 'interrupted')
      return
    }

    await this.setStatus(instance, 'thinking')

    const allText: string[] = []
    const allReasoning: string[] = []
    let usage: UsageEvent | undefined
    let finishReason: 'stop' | 'tool_calls' | 'length' = 'stop'
    let session: ChatMessage[] = [...delivery.messages]
    // 当前轮累积（中断时在 for-await 内部抛出，尚未合并进 allText，需保留供 halt 收尾）。
    let roundText: string[] = []
    let roundReasoning: string[] = []
    // 工具物化：registry 经族谱台账查询本 agent 的生效访问（白名单/收敛已物化）。
    const tools = this.deps.tools ? this.deps.tools.materialize(instance.id) : undefined
    let steps = 0

    // 本轮中断控制器：注册进活跃表，供 kernel/宿主 abort（用户/进程中断）。
    const ctl = new AbortController()
    this.controllers.set(instance.id, ctl)

    try {
      while (steps < this.maxSteps) {
        roundText = []
        roundReasoning = []
        const toolCalls: ToolCallEvent[] = []
        let roundUsage: UsageEvent | undefined
        let roundFinish: 'stop' | 'tool_calls' | 'length' = 'stop'

        // 请求已发 → thinking。
        await this.setStatus(instance, 'thinking')
        const request: LLMRequest = { model, system: delivery.system, messages: session, tools }
        const roundStart = Date.now()
        for await (const event of this.deps.gateway.chat(request, { signal: ctl.signal })) {
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

        // 记录模型调用（token 消耗 / 延迟 / 成本）。
        this.deps.onLog?.log({
          type: 'gateway.apiRequest',
          at: Date.now(),
          agentId: instance.id,
          model: model.id,
          provider: model.provider,
          promptTokens: roundUsage?.inputTokens,
          completionTokens: roundUsage?.outputTokens,
          cacheReadTokens: roundUsage?.cacheReadTokens,
          cacheWriteTokens: roundUsage?.cacheWriteTokens,
          latencyMs: Date.now() - roundStart,
          cost: this.estimateCost(roundUsage),
        })

        // LLM 已返回（assistant 或 tool_call）→ holding，等待下一次送信/续轮。
        await this.setStatus(instance, 'holding')

        const assistantMessage: ChatMessage = {
          role: 'assistant',
          content: roundText.join(''),
          toolCalls: toolCalls.length > 0 ? toolCalls.map(toProtocolToolCall) : undefined,
        }
        session = [...session, assistantMessage]
        // 自动复制 assistant 消息到邮局历史（output = 本请求生成段的真实 tokens，直记免差分）。
        await this.deps.contextManager.appendHistory(
          instance.id,
          assistantMessage,
          roundUsage !== undefined ? { tokens: roundUsage.outputTokens } : undefined,
        )
        // 累积差分归位：把「相对上次请求的 input 增量」真实值回填到两轮之间的 tool/user 行。
        if (roundUsage !== undefined) {
          await this.deps.contextManager.attributeUsage(instance.id, roundUsage)
        }

        // 显式退出条件：无工具调用 → 结束会话。
        if (roundFinish !== 'tool_calls' || toolCalls.length === 0 || !this.deps.tools) break

        // 工具轮：并行执行（协议原生支持多个 tool_call），结果按调用顺序回填。
        const ctx: ToolContext = {
          agentId: instance.id,
          spaceId: instance.spaceId,
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

      // 统计走显式通道（累加即写穿落行——轮终态 holding 在循环内已置，
      // 引用直改会滞后一整轮；随后保持 holding 等待快递员下一次送信）
      await this.deps.instances.recordTurnEnd(instance.id, { turns: 1, cost: this.estimateCost(usage) })

      // 最终回复：寄给创建者（= 族谱父；发原始文本，发送者戳由管理员打标签时统一生成）。
      const finalText = allText.join('')
      if (finalText !== '') {
        await this.deps.contextManager.deposit(instance.parentId ?? 'user0', { role: 'user', content: finalText }, instance.id)
      }
    } catch (cause) {
      // 中断/错误发生在当前轮 for-await 内部：roundText 持有中断前已产出的部分文本。
      await this.halt(instance, cause, { partialText: roundText.join(''), partialReasoning: roundReasoning.join('') })
    } finally {
      this.controllers.delete(instance.id)
    }
  }

  /**
   * 中断/错误收尾：保证消息闭合（消息完整性）。
   * - 主动中断（abort）：已产出的部分 assistant 补 `<interrupted>` 标记入库；
   * - 网关/工具错误：部分 assistant 原样入库 + 错误日志；
   * - 状态 → interrupted（实例存活、可恢复）。
   */
  private async halt(
    instance: { readonly id: AgentID; status: AgentStatus },
    cause: unknown,
    partial: { partialText: string; partialReasoning: string },
  ): Promise<void> {
    const aborted = isAbortError(cause)
    const gatewayError = isGatewayError(cause)
    // 主动中断 → 补 <interrupted> 标记（消息闭合，避免误导模型以为是完整回复）；
    // 其它错误 → 原样保留部分文本（不伪造"完成"标记）。
    const message =
      aborted && partial.partialText !== ''
        ? `${partial.partialText}\n${INTERRUPTED_MARKER}`
        : partial.partialText

    // 消息闭合：中断时已有部分 assistant 文本 → 补一条带标记的 assistant 入库，
    // 避免下一轮组装出现"assistant 后直接接 user"的非法消息序列。
    if (message !== '') {
      await this.deps.contextManager.appendHistory(instance.id, { role: 'assistant', content: message })
    }

    this.deps.onLog?.log({
      type: 'kernel.instance.interrupted',
      at: Date.now(),
      agentId: instance.id,
      aborted,
      errorKind: gatewayError ? cause.kind : undefined,
      message: gatewayError ? cause.message : aborted ? 'aborted' : String(cause),
    })

    await this.setStatus(instance, 'interrupted')
  }

  async notifyHold(agentId: AgentID): Promise<void> {
    const instance = await this.deps.instances.get(agentId)
    await this.setStatus(instance, 'holding')
  }

  /** 状态变化（thinking/holding/interrupted…）→ 实例状态更新 + 日志 + 事件流通知。 */
  private async setStatus(instance: { readonly id: AgentID; status: AgentStatus }, to: AgentStatus): Promise<void> {
    if (instance.status === to) return
    const from = instance.status
    await this.deps.instances.updateStatus(instance.id, to)
    this.deps.onLog?.log({ type: 'kernel.status.changed', at: Date.now(), agentId: instance.id, from, to })
    this.deps.onStatus?.(instance.id, from, to)
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
