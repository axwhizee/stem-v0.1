// ============================================================
// core/context/strategies/classic.ts —— classic 策略（对齐 opencode compact）
//
// 完整历史直出 + **上下文压缩**：估算 token 逼近窗口（threshold×window）
// 时，把轮边界之前的旧消息交给摘要 worker（summarizer 系统 agent，
// 挂在策略扮演 agent 名下）精炼为一条 <context_summary> 合成消息，
// 旧消息 markInvalid——仓库/DB 语料保留，压缩可逆可审计（opencode 无此优势）。
//
// 触发点 = user_prompt 信件抵达（process）；轮边界压缩 + append-only →
// 前缀缓存稳定。手动通道：actions.compact（pilot / CLI / context_apply）。
// 角色模板（role/worker）硬编码于本模块（决策 C：策略自带人设，不共用
// 统一模板类）；worker 策略 = none，断绝递归。
// ============================================================

import type { AssembleInput, AssembleResult, StoredMessage } from '../types'
import { messageText } from '../types'
import type { ContextSettings, ContextStrategyModule, StrategyAgentSpec, StrategyApi } from './types'
import type { AgentClass } from '../../kernel/types'
import { makeAgentClassID } from '../../kernel/types'

/** 经典组装：system + 全部有效消息原样直出（压缩由 process 阶段完成）。 */
export function classicAssemble(input: AssembleInput): AssembleResult {
  const systemIndex = input.messages.findIndex((m) => m.message.role === 'system')
  const system = systemIndex >= 0 ? messageText(input.messages[systemIndex]!.message) : ''
  const rest = input.messages.filter((m) => m.message.role !== 'system')
  return {
    system,
    messages: rest.map((m) => m.message),
    messageIds: input.messages.map((m) => m.id),
    tools: input.tools,
  }
}

/** classic 扮演 agent 规格（懒生成，父 = 宿主 agent；面板态不跑 LLM）。 */
export const CLASSIC_ROLE: AgentClass = {
  name: makeAgentClassID('strategy-classic'),
  description: 'classic 策略扮演 agent：摘要 worker 的父与回信收集点（审计信箱，模块扮演，无 LLM 轮）',
  systemPrompt: '（模块扮演面板）classic 上下文策略的执行体：接收宿主 agent 委托的摘要任务 worker 的回信并留档审计；不参与 LLM 组装。',
  tools: {},
  sendCountdown: 0,
  contextStrategy: 'none',
}

/** 摘要 worker 规格（策略机制创建；零工具纯 LLM 总结）。 */
export const SUMMARIZER_SPEC: AgentClass = {
  name: makeAgentClassID('summarizer'),
  description: '系统摘要 worker：压缩精炼对话历史的专职任务 agent（策略机制创建，零工具）',
  systemPrompt:
    '你是 stem 系统的记忆压缩器。把给定的对话历史浓缩为一份结构化摘要，保留：①用户意图与要求；②关键事实/决定/结论；③已完成操作要点（文件与工具动作）；④未决问题与下一步。删除冗余、重复与过时信息，只输出摘要正文。',
  tools: {},
  sendCountdown: 0,
  contextStrategy: 'none',
}

const DEFAULT_INSTRUCTION = '请把下面这段对话历史压缩成一份精炼摘要（保留关键事实、意图与结论，去除冗余）：'

export function createClassicStrategy(): ContextStrategyModule {
  return {
    name: 'classic',
    note:
      '<stem_context>你的上下文策略为 classic：完整历史原样保留；当接近上下文窗口上限时，' +
      '系统会把较早轮次替换为 <context_summary> 摘要消息（原始消息归档不丢失）。' +
      '必要时可经 context_apply(action="compact") 手动触发压缩。</stem_context>',
    role: CLASSIC_ROLE,
    assemble: classicAssemble,
    process: async (api) => {
      await maybeCompact(api)
    },
    actions: {
      compact: async (api) => compactNow(api, 'manual'),
    },
  }
}

// ---------- compact ----------

async function maybeCompact(api: StrategyApi): Promise<void> {
  const compact: ContextSettings['compact'] = api.settings.compact
  if (!compact.enabled) return
  const budget = Math.max(1, Math.floor(api.settings.window * compact.threshold))
  if (api.estimatedTokens() < budget) return
  await compactNow(api, 'auto')
}

async function compactNow(api: StrategyApi, trigger: 'auto' | 'manual'): Promise<string> {
  try {
    const valid = api.listValid()
    const history = valid.filter((m) => m.message.role !== 'system')
    if (history.length === 0) {
      api.log({ type: 'context.compacted', agentId: api.agentId, outcome: 'skipped', compactedCount: 0, message: '无历史消息' })
      return '无历史消息可压缩'
    }
    const maxTurn = history.reduce((acc, m) => Math.max(acc, m.turn), 0)
    const cutoff = maxTurn - api.settings.compact.keepRecentTurns
    const stale = history.filter((m) => m.turn <= cutoff)
    if (cutoff < 1 || stale.length === 0) {
      api.log({ type: 'context.compacted', agentId: api.agentId, outcome: 'skipped', compactedCount: 0, message: `轮数不足（maxTurn=${maxTurn}）` })
      return `轮数不足（当前 ${maxTurn} 轮，保留最近 ${api.settings.compact.keepRecentTurns} 轮），未压缩`
    }

    // 交给摘要 worker（邮局正规往返：策略扮演 agent 为父，回信配对）。
    const transcript = stale.map(renderForSummary).join('\n')
    const instruction = api.settings.compact.instruction ?? DEFAULT_INSTRUCTION
    // S6/R6：摘要 worker 模型 = 类基因位（config context.compact.summarizeModel）；
    // 未配置则走出生链（父继承宿主 agent 档案 > 家学），不再有独立兜底常量。
    const summarizeModel = api.settings.compact.summarizeModel
    const spec: AgentClass = summarizeModel !== undefined ? { ...SUMMARIZER_SPEC, model: summarizeModel } : SUMMARIZER_SPEC
    const summary = (await api.spawn(`${instruction}\n\n${transcript}`, spec)).trim()
    if (summary === '') {
      api.log({ type: 'context.compacted', agentId: api.agentId, outcome: 'skipped', compactedCount: 0, message: '摘要为空/超时' })
      return '摘要为空（worker 未产出或超时），本轮未压缩'
    }

    // 旧段标记无效 + 摘要经邮局正规追加（write-through 自动落库）。
    await api.markInvalid(stale.map((m) => m.id))
    await api.append(
      { role: 'user', content: `<context_summary turns="1-${String(cutoff)}">\n${summary}\n</context_summary>` },
      'summary',
    )
    api.log({
      type: 'context.compacted',
      agentId: api.agentId,
      outcome: 'compacted',
      compactedCount: stale.length,
      message: `${trigger} 压缩 ${String(stale.length)} 条消息（turn<=${String(cutoff)}）`,
    })
    return `已压缩 ${String(stale.length)} 条消息（turn<=${String(cutoff)}，${trigger}）`
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : JSON.stringify(cause)
    api.log({ type: 'context.compacted', agentId: api.agentId, outcome: 'failed', compactedCount: 0, message })
    // 绝不抛出到送信链路（process 兜底另有 catch）。
    return `压缩失败（${message}），上下文未改动`
  }
}

/** 摘要任务的旧消息渲染（截断防爆 token）。 */
function renderForSummary(m: StoredMessage): string {
  const msg = m.message
  const body = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
  const clipped = body.length > 400 ? `${body.slice(0, 400)}…` : body
  const calls =
    'toolCalls' in msg && msg.toolCalls !== undefined && msg.toolCalls.length > 0
      ? ` [calls: ${msg.toolCalls.map((c) => c.name).join(',')}]`
      : ''
  return `(${String(m.turn)}) ${msg.role}: ${clipped}${calls}`
}


