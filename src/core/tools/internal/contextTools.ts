// ============================================================
// core/tools/internal/contextTools.ts —— 上下文资产与挂起工具
//
// 注册即注册声明；消费方拥有端口（./ports），零 kernel import。
// ============================================================

import type { ToolCapability } from '../types'
import type { SystemToolHost } from './ports'
import { resolveOr, resolveReachable } from './shared'

export function agentPause(host: SystemToolHost): ToolCapability {
  return {
    id: 'agent_pause',
    description:
      '挂起自己一段时间：ms 后自动唤醒，期间收到的新信件全部堆积在上下文里，' +
      '醒来时一次组装可见。适合"等待多方消息汇聚再判断"的节奏控制。',
    accessKey: 'agent_pause',
    registerAccess: 'ignore', // 注册声明（agent_pause）
    kind: 'internal',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        ms: { type: 'number', description: '挂起毫秒数（到点唤醒）' },
        reason: { type: 'string', description: '挂起原因（可选，仅入审计日志）' },
      },
      required: ['ms'],
    },
    validate: (input) => {
      const a = input as { ms?: unknown }
      if (typeof a.ms !== 'number' || !Number.isFinite(a.ms) || a.ms <= 0) return 'ms 必须是正数'
      return undefined
    },
    execute: async (input, ctx) => {
      const { ms } = input as { ms: number }
      await host.context.registerPause(ctx.agentId, { toolCallId: ctx.callId ?? '', ms })
      return { text: '', metadata: { contextWait: true } }
    },
  }
}

/** 导出上下文为 jsonl（只读；agent 只能导出自己的上下文）。 */
export function contextExport(host: SystemToolHost): ToolCapability {
  return {
    id: 'context_export',
    description: '导出指定 agent 的完整上下文为 jsonl（逐行 JSON，含 tag/turn/indexInTurn）。只读，不修改上下文。',
    accessKey: 'context_export',
    registerAccess: 'ignore', // 注册声明（context_export）
    kind: 'internal',
    category: 'context',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'agent id（缺省为调用者自身）' },
      },
    },
    execute: async (input, ctx) => {
      const resolved = resolveReachable(host, ctx.agentId, (input as { agentId?: string }).agentId ?? ctx.agentId, () => '无权导出该 agent 的上下文')
      if ('text' in resolved) return { text: resolved.text }
      const agentId = resolved.id
      const jsonl = await host.context.exportJsonl(agentId)
      return { text: jsonl === '' ? '（空上下文）' : jsonl }
    },
  }
}

/** 上下文概览（只读反射；agent 只能查看自己的上下文）。 */
export function contextOverview(host: SystemToolHost): ToolCapability {
  return {
    id: 'context_overview',
    description:
      '查看指定 agent 的上下文概览：每条消息的 role / turn / tag / token 占比 / 索引。只读反射，不修改上下文。用于 agent 自省上下文构成。',
    accessKey: 'context_overview',
    registerAccess: 'ignore', // 注册声明（context_overview）
    kind: 'internal',
    category: 'context',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'agent id（缺省为调用者自身）' },
      },
    },
    execute: async (input, ctx) => {
      const resolved = resolveReachable(host, ctx.agentId, (input as { agentId?: string }).agentId ?? ctx.agentId, () => '无权查看该 agent 的上下文')
      if ('text' in resolved) return { text: resolved.text }
      const agentId = resolved.id
      return { text: await host.context.overview(agentId) }
    },
  }
}

/** 删除上下文中的过时消息（标记无效，组装时跳过；删除后组装统一过 legalize 保证可经 gateway 发送）。 */
export function contextRemove(host: SystemToolHost): ToolCapability {
  return {
    id: 'context_remove',
    description:
      '删除指定 agent 上下文中的过时消息（标记无效，组装时跳过，不物理清除）。可删任意消息（system 除外）；删除后上下文经 legalize 保证消息序列合法。用于清理过时工具结果/过期总结等。',
    accessKey: 'context_remove',
    registerAccess: 'ignore', // 注册声明（context_remove）
    kind: 'internal',
    category: 'context',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: '目标 agent id（缺省为调用者自身；仅自身或祖先可删）' },
        messageIds: { type: 'array', items: { type: 'string' }, description: '要删除的消息 id 列表（来自 context_export/overview）' },
        turn: { type: 'number', description: '删除整轮（按轮号，优先级高于 messageIds）' },
      },
    },
    execute: async (input, ctx) => {
      const args = input as { agentId?: string; messageIds?: string[]; turn?: number }
      const resolved = resolveReachable(host, ctx.agentId, args.agentId, () => '无权删除该 agent 的上下文')
      if ('text' in resolved) return { text: resolved.text }
      const target = resolved.id
      const state = await host.context.getState(target)
      const ids = args.turn !== undefined ? state.messages.filter((m) => m.turn === args.turn).map((m) => m.id) : (args.messageIds ?? [])
      // system 消息不可删。
      const systemIds = new Set(state.messages.filter((m) => m.role === 'system').map((m) => m.id))
      const removable = ids.filter((id) => !systemIds.has(id))
      if (removable.length === 0) return { text: '无消息可删除（system 消息不可删）' }
      await host.context.markInvalid(target, removable)
      return { text: `已删除 ${removable.length} 条消息（agent ${target}）` }
    },
  }
}

/** 重写上下文中的某条消息内容（保留 role/索引；改后组装过 legalize 保证合法）。 */
export function contextEdit(host: SystemToolHost): ToolCapability {
  return {
    id: 'context_edit',
    description: '重写指定 agent 上下文中的某条消息内容（保留 role/索引；system 消息不可改）。',
    accessKey: 'context_edit',
    registerAccess: 'ignore', // 注册声明（context_edit）
    kind: 'internal',
    category: 'context',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: '目标 agent id（缺省为调用者自身；仅自身或祖先可改）' },
        messageId: { type: 'string', description: '消息 id（来自 context_export/overview）' },
        content: { type: 'string', description: '新内容' },
      },
      required: ['messageId', 'content'],
    },
    execute: async (input, ctx) => {
      const args = input as { agentId?: string; messageId: string; content: string }
      const resolved = resolveReachable(host, ctx.agentId, args.agentId, () => '无权修改该 agent 的上下文')
      if ('text' in resolved) return { text: resolved.text }
      const target = resolved.id
      const state = await host.context.getState(target)
      const stored = state.messages.find((m) => m.id === args.messageId)
      if (!stored) return { text: `消息不存在: ${args.messageId}` }
      if (stored.role === 'system') return { text: 'system 消息不可修改' }
      await host.context.updateMessageContent(target, args.messageId, args.content)
      return { text: `已更新消息 ${args.messageId}` }
    },
  }
}

/** 执行上下文策略专有动作（策略独立接口的模型侧通道；agent 只能操作自身，祖先可代操作）。 */
export function contextApply(host: SystemToolHost): ToolCapability {
  return {
    id: 'context_apply',
    description:
      '执行该 agent 上下文管理策略的专有动作（如 classic 的 compact 手动压缩历史；cortex 的 dream 提前做梦固化记忆）。action 取值见系统提示中的 <stem_context>。仅能操作自身上下文（祖先可代子孙触发）。',
    accessKey: 'context_apply',
    registerAccess: 'ignore', // 注册声明（context_apply）
    kind: 'internal',
    category: 'context',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: '目标 agent id（缺省为调用者自身；仅自身或祖先可操作）' },
        action: { type: 'string', description: '策略动作名（如 compact）' },
        args: { type: 'string', description: '动作参数（策略自定义，可选）' },
      },
      required: ['action'],
    },
    execute: async (input, ctx) => {
      const args = input as { agentId?: string; action: string; args?: string }
      const resolved = resolveReachable(host, ctx.agentId, args.agentId, () => '无权操作该 agent 的上下文策略')
      if ('text' in resolved) return { text: resolved.text }
      const target = resolved.id
      const result = await host.context.runStrategyAction(target, args.action, args.args ?? '')
      return { text: result }
    },
  }
}

/** 批准/拒绝访问申请（ask 消息化的回复侧；授权权：仅申请者的族谱根可调用）。 */
