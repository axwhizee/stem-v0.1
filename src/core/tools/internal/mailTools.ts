// ============================================================
// core/tools/internal/mailTools.ts —— 邮局通信工具
//
// 注册即出生声明；消费方拥有端口（./ports），零 kernel import。
// ============================================================

import type { ToolCapability } from '../types'
import type { SystemToolHost } from './ports'
import { resolveOr } from './shared'

export function mailSend(host: SystemToolHost): ToolCapability {
  return {
    id: 'mail_send',
    description: '向指定参与者投递信件（单目标，一对多请并行调用多次）。消息自动添加发送者戳。',
    accessKey: 'mail_send',
    birth: 'ignore', // 出生声明（mail_send）
    kind: 'internal',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '目标参与者（name / name#id / id 三形态；mail_participants 可查在册全名）' },
        message: { type: 'string', description: '消息内容' },
      },
      required: ['to', 'message'],
    },
    execute: async (input, ctx) => {
      const { to, message } = input as { to: string; message: string }
      const resolved = resolveOr(host, to)
      if ('text' in resolved) return { text: resolved.text }
      await host.agents.sendMessage(ctx.agentId, resolved.id, message)
      return { text: `已发送消息给 ${host.agents.displayOf(resolved.id)}` }
    },
  }
}

/** 查询邮局在册参与者。 */
export function mailParticipants(host: SystemToolHost): ToolCapability {
  return {
    id: 'mail_participants',
    description: '列出当前邮局在册参与者（全名 `name#id`，可直接作 mail_send 的 to）。',
    accessKey: 'mail_participants',
    birth: 'ignore', // 出生声明（mail_participants）
    kind: 'internal',
    category: 'system',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const ids = await host.agents.listParticipants()
      return { text: ids.length > 0 ? `参与者: ${ids.join(', ')}` : '（暂无参与者）' }
    },
  }
}

/**
 * 自主挂起（S9）：agent 判断自己需要暂停攒信时调用——ms 到点自动唤醒，
 * 期间来信照常进信箱（醒来后一次组装全部在场）。无时长上限（用户裁决：
 * 数小时挂起合法；孤儿风险由 ContextManager 注销清理兜底）。
 * 等特定子的回信不用它——用 agent_instantiate 的 wait 参数。
 */
