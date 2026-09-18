// ============================================================
// core/tools/internal/telemetryTools.ts —— 遥测查询与行渲染
//
// 注册即注册声明；消费方拥有端口（./ports），零 kernel import。
// ============================================================

import type { ToolCapability } from '../types'
import type { SystemToolHost } from './ports'
import type { LogEvent } from '../../logging'
import { eventInvolvesAgent } from '../../logging'
import { resolveOr, resolveReachable } from './shared'

export function telemetryQuery(host: SystemToolHost): ToolCapability {
  return {
    id: 'telemetry_query',
    description:
      '查询系统运行日志（telemetry 观测面）：工具调用/模型请求/信箱活动/权限交互/上下文动作/类注册与书写审计。可查自身或族谱后代（你是其祖先）；行式压缩输出。进化回路的"观测"支柱。',
    accessKey: 'telemetry_query',
    registerAccess: 'ignore', // 注册声明（telemetry_query）
    kind: 'internal',
    category: 'telemetry',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: '目标 agent id（缺省 = 调用者自身；后代可查）' },
        types: { type: 'array', items: { type: 'string' }, description: "事件类型过滤（如 'tool.invoked'；支持 'gateway.*' 前缀通配）" },
        since: { type: 'number', description: '起始时间戳（毫秒，含）' },
        until: { type: 'number', description: '截止时间戳（毫秒，含）' },
        limit: { type: 'number', description: '返回条数上限（缺省 50，硬顶 200；取最近 N 条）' },
      },
    },
    execute: async (input, ctx) => {
      const args = input as { agentId?: string; types?: string[]; since?: number; until?: number; limit?: number }
      const resolved = resolveReachable(host, ctx.agentId, args.agentId, (id) => `无权查看该 agent 的运行日志（可见域 = 自身 + 族谱后代）: ${id}`)
      if ('text' in resolved) return { text: resolved.text }
      const target = resolved.id
      const limit = Math.min(Math.max(args.limit ?? 50, 1), 200)
      const patterns = args.types ?? []
      const matches = (event: LogEvent): boolean => {
        if (!eventInvolvesAgent(event, target)) return false
        if (patterns.length > 0 && !patterns.some((p) => (p.endsWith('*') ? event.type.startsWith(p.slice(0, -1)) : event.type === p))) {
          return false
        }
        if (args.since !== undefined && event.at < args.since) return false
        if (args.until !== undefined && event.at > args.until) return false
        return true
      }
      const events = host.telemetry.allLogs().filter(matches)
      if (events.length === 0) return { text: '(no events)' }
      const shown = events.slice(-limit)
      const header = `${host.agents.displayOf(target)} | ${shown.length} 条${events.length > shown.length ? `（最近 ${shown.length} 条，共匹配 ${events.length}）` : ''}`
      return { text: `${header}\n${shown.map(formatTelemetryRow).join('\n')}` }
    },
  }
}

/** 单事件 → 行式压缩（`时刻 | 类型 | 摘要`；摘要按类型取关键字段，不 dump 大负载）。 */
export function formatTelemetryRow(event: LogEvent): string {
  const time = new Date(event.at).toISOString().slice(11, 23)
  return `${time} | ${event.type} | ${telemetryBrief(event)}`
}

function telemetryBrief(event: LogEvent): string {
  switch (event.type) {
    case 'tool.invoked':
      return `${event.tool} ${event.phase}${event.durationMs !== undefined ? ` ${event.durationMs}ms` : ''}${event.errorKind !== undefined ? ` [${event.errorKind}]` : ''}`
    case 'gateway.apiRequest':
      return `${event.provider}/${event.model} tok=${event.promptTokens ?? '-'}/${event.completionTokens ?? '-'} cost=${event.cost.toFixed(4)} ${event.latencyMs}ms`
    case 'context.assembled':
      return `assemble=${event.assemble} n=${event.messageCount}`
    case 'context.compacted':
      return `${event.outcome} n=${event.compactedCount}`
    case 'context.dreamed':
      return `${event.consolidated ? 'dreamed' : 'aborted'} invalid=${event.invalidRows} notes=${event.notesTouched}`
    case 'context.strategy.fallback':
      return `${event.site} 期望[${event.expected}] 实接[${event.actual}]——${event.message}`
    case 'kernel.step.limit':
      return `步数上限 ${event.maxSteps} 收束本轮`
    case 'mailbox.countdown':
      return event.action
    case 'mailbox.delivered':
      return `${event.kind} n=${event.messageCount}`
    case 'kernel.class.registered':
      return `class=${event.classId}${event.persisted === undefined ? '' : event.persisted ? ' persisted' : ' in-memory'}`
    case 'kernel.class.updated':
      return `class=${event.classId} patch=${event.patch} ${event.persisted ? 'persisted' : 'in-memory'}`
    case 'kernel.instance.created':
      return `class=${event.classId} parent=${event.parentId === '' ? 'root' : event.parentId}`
    case 'kernel.status.changed':
      return `${event.from}→${event.to}`
    case 'kernel.instance.terminated':
      return 'terminated'
    case 'kernel.instance.updated':
      return `by=${event.by} fields=[${event.fields.join(',')}]`
    case 'kernel.model.set':
      return `model→${event.provider}/${event.model}${event.by !== undefined ? ` by=${event.by}` : ''}`
    case 'kernel.instance.interrupted':
      return `${event.aborted ? 'abort' : 'error'} ${event.message}`
    case 'kernel.message.sent':
      return `${event.from}→${event.to} ${event.kind} ${event.payloadSize}B`
    case 'access.asked':
      return `${event.accessKey} ${event.action}`
    case 'access.replied':
      return `${event.accessKey} ${event.reply}`
    case 'init.tool.registered':
      return `tool=${event.tool} file=${event.file}`
    case 'init.agent.registered':
      return `class=${event.classId} file=${event.file}`
    default:
      return JSON.stringify(event).slice(0, 160)
  }
}

/** 格式化生效访问（权限台账物化出示：显式判定 + 本地封闭/不设限）。 */
