// ============================================================
// shell/feishu/cards.ts —— 飞书交互卡片 JSON 构造（纯函数）
//
// 卡片 schema 2.0；审批按钮以 value 携带裁决语义
// （{act:'access', reply, requestId}），回调经 card.action.trigger 长连接事件。
// ============================================================

import type { AccessRequestView } from './router'

export interface CardJson {
  readonly schema: '2.0'
  readonly header?: unknown
  readonly body: { readonly elements: readonly unknown[] }
}

/** 审批卡：申请详情 + 三键（once/always/reject）。 */
export function approvalCard(req: AccessRequestView): CardJson {
  return {
    schema: '2.0',
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: `🔐 工具审批 · ${req.accessKey}` },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [
            `**申请者**：\`${req.agentId}\``,
            `**工具**：\`${req.accessKey}\``,
            req.detail.trim() === '' ? '' : `**详情**：${req.detail.trim()}`,
            '',
            '点击裁决（会话内 always = 免询问备忘；拒绝后 agent 可改道或再申请）：',
          ].filter((line) => line !== '').join('\n'),
        },
        {
          tag: 'action',
          actions: [
            { tag: 'button', text: { tag: 'plain_text', content: '允许一次' }, type: 'primary', value: { act: 'access', reply: 'once', requestId: req.requestId } },
            { tag: 'button', text: { tag: 'plain_text', content: '本会话总是' }, type: 'default', value: { act: 'access', reply: 'always', requestId: req.requestId } },
            { tag: 'button', text: { tag: 'plain_text', content: '拒绝' }, type: 'danger', value: { act: 'access', reply: 'reject', requestId: req.requestId } },
          ],
        },
      ],
    },
  }
}

/** 审批卡裁决后原地更新态（保留可审计，按钮撤下）。 */
export function approvalDecidedCard(req: AccessRequestView, decision: string): CardJson {
  return {
    schema: '2.0',
    header: {
      template: decision === 'reject' ? 'red' : 'green',
      title: { tag: 'plain_text', content: `🔐 已裁决 · ${decision === 'reject' ? '拒绝' : decision === 'always' ? '本会话总是' : '允许一次'}` },
    },
    body: {
      elements: [
        { tag: 'markdown', content: `**申请者**：\`${req.agentId}\`\n**工具**：\`${req.accessKey}\`\n\n（该申请已处理，卡片留档。）` },
      ],
    },
  }
}

/** 通用信息卡（tree/logs/help 等富文本，无按钮）。 */
export function infoCard(title: string, markdown: string, template = 'blue'): CardJson {
  return {
    schema: '2.0',
    header: { template, title: { tag: 'plain_text', content: title } },
    body: { elements: [{ tag: 'markdown', content: markdown }] },
  }
}
