// ============================================================
// core/tools/internal/accessTools.ts —— ask 审批回复工具
//
// 注册即出生声明；消费方拥有端口（./ports），零 kernel import。
// ============================================================

import type { ToolCapability, AccessReply } from '../types'
import type { SystemToolHost } from './ports'

export function accessReply(host: SystemToolHost): ToolCapability {
  return {
    id: 'access_reply',
    description:
      '批准或拒绝访问申请。请求以 access_request 消息形式到达你的信箱（含 requestId / 申请工具 / 申请 agent）；用本工具回复 once（单次）/ always（始终批准）/ reject（拒绝，可带 feedback 告知申请 agent）。授权权：仅申请者的族谱根可答复。',
    accessKey: 'access_reply',
    birth: 'allow', // 出生声明（access_reply）
    kind: 'internal',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: '访问申请 id（来自信箱中的 access_request 消息）' },
        reply: { type: 'string', enum: ['once', 'always', 'reject'], description: 'once=单次 / always=始终 / reject=拒绝' },
        feedback: { type: 'string', description: 'reject 时的反馈（告知申请 agent）' },
      },
      required: ['requestId', 'reply'],
    },
    execute: async (input, ctx) => {
      const args = input as { requestId: string; reply: AccessReply; feedback?: string }
      await host.access.reply(
        {
          requestId: args.requestId,
          reply: args.reply,
          ...(args.feedback !== undefined ? { message: args.feedback } : {}),
        },
        ctx.agentId,
      )
      return { text: `已回复访问申请 ${args.requestId}: ${args.reply}` }
    },
  }
}

/**
 * 运行日志观测（S5.2 进化观测面，方案 §4.1）：telemetry 类目 internal 工具，
 * 缺省 ignore（隐藏但可用——评估者类显式声明才可见）。可见域 = **树位置函数**：
 * 自身 ∪ 祖先代查（后代可查、兄弟不可见、根天然全视），与 context_* 工具同一
 * canReach 谓词。行式压缩输出（控制 token 面）。
 */
