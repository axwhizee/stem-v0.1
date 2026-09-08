// ============================================================
// shell/feishu/feishu.ts —— 飞书平台适配（SDK 依赖唯一定义域）
//
// 官方 SDK @larksuiteoapi/node-sdk：WSClient 长连接（免公网、自动重连）+
// Client REST 发送。具名导入（default export 不存在，手册坑 1）；
// 事件载荷 msg_type/message_type 双形兼容读取（手册坑 2）。
// 本层只做协议翻译，全部决策在 router.ts。
// ============================================================

import { Client, EventDispatcher, WSClient, LoggerLevel } from '@larksuiteoapi/node-sdk'
import { splitForChat, type FetchedMsg, type InboundMsg } from './router'

export interface CardActionEvent {
  readonly value: unknown
  readonly messageId: string
  readonly openId: string
}

export interface FeishuPlatform {
  readonly sendText: (chatId: string, text: string) => Promise<void>
  /** 发交互卡，返回 message_id（后续 updateCard 定点更新）。 */
  readonly sendCard: (chatId: string, card: unknown) => Promise<string>
  readonly updateCard: (messageId: string, card: unknown) => Promise<void>
  readonly onMessage: (handler: (msg: InboundMsg) => void) => void
  readonly onCardAction: (handler: (ev: CardActionEvent) => void) => void
  /** 建立长连接（内部自动重连；resolve 仅代表启动成功，就绪看日志）。 */
  readonly start: () => Promise<void>
  /** 拉取会话历史（断线补偿；升序、自 afterMs 起、上限 limit 条）。 */
  readonly listMessages: (chatId: string, afterMs: number, limit: number) => Promise<FetchedMsg[]>
}

export function createFeishuPlatform(appId: string, appSecret: string): FeishuPlatform {
  const client = new Client({ appId, appSecret })
  const messageHandlers: Array<(msg: InboundMsg) => void> = []
  const cardHandlers: Array<(ev: CardActionEvent) => void> = []

  const dispatcher = new EventDispatcher({}).register({
    'im.message.receive_v1': async (data: unknown) => {
      const d = (data ?? {}) as {
        message?: Record<string, unknown>
        sender?: { sender_id?: { open_id?: string } }
      }
      const m = d.message
      if (!m || typeof m.message_id !== 'string' || typeof m.chat_id !== 'string') return
      const msgType = (m.msg_type ?? m.message_type ?? 'text') as string
      let text = `[暂不支持的消息类型: ${msgType}]`
      if (msgType === 'text' && typeof m.content === 'string') {
        try {
          text = String((JSON.parse(m.content) as { text?: string }).text ?? '')
        } catch {
          text = ''
        }
      }
      for (const h of messageHandlers) {
        h({
          messageId: m.message_id,
          chatId: m.chat_id,
          chatType: m.chat_type === 'p2p' ? 'p2p' : 'group',
          openId: d.sender?.sender_id?.open_id ?? '',
          text,
        })
      }
    },
    // 卡片按钮回调（长连接通道，手册 §8）；载荷形状做防御读取。
    'card.action.trigger': async (data: unknown) => {
      const d = (data ?? {}) as Record<string, unknown>
      const action = d.action as Record<string, unknown> | undefined
      const context = d.context as Record<string, unknown> | undefined
      const operator = d.operator as Record<string, unknown> | undefined
      for (const h of cardHandlers) {
        h({
          value: action?.value,
          messageId: String(context?.open_message_id ?? d.open_message_id ?? ''),
          openId: String(operator?.open_id ?? ''),
        })
      }
    },
  })

  const ws = new WSClient({ appId, appSecret, loggerLevel: LoggerLevel.info })

  return {
    async sendText(chatId, text) {
      for (const chunk of splitForChat(text)) {
        await client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: chunk }) },
        })
      }
    },
    async sendCard(chatId, card) {
      const resp = await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
      })
      return String((resp as { data?: { message_id?: string } })?.data?.message_id ?? '')
    },
    async updateCard(messageId, card) {
      if (messageId === '') return
      await client.im.v1.message.update({
        path: { message_id: messageId },
        data: { msg_type: 'interactive', content: JSON.stringify(card) },
      })
    },
    onMessage(handler) {
      messageHandlers.push(handler)
    },
    onCardAction(handler) {
      cardHandlers.push(handler)
    },
    async start() {
      await ws.start({ eventDispatcher: dispatcher })
    },
    async listMessages(chatId, afterMs, limit) {
      const out: FetchedMsg[] = []
      let pageToken = ''
      for (let page = 0; page < Math.ceil(limit / 50) && out.length < limit; page++) {
        const resp = await client.im.v1.message.list({
          params: {
            container_id_type: 'chat',
            container_id: chatId,
            sort_type: 'ByCreateTimeAsc',
            ...(afterMs > 0 ? { start_time: String(afterMs) } : {}),
            page_size: 50,
            ...(pageToken !== '' ? { page_token: pageToken } : {}),
          },
        })
        const data = (resp as { data?: { items?: unknown[]; has_more?: boolean; page_token?: string } })?.data
        for (const raw of data?.items ?? []) {
          const m = (raw ?? {}) as Record<string, unknown>
          const sender = (m.sender ?? {}) as Record<string, unknown>
          const body = (m.body ?? {}) as Record<string, unknown>
          let text = ''
          if (m.msg_type === 'text' && typeof body.content === 'string') {
            try {
              text = String((JSON.parse(body.content) as { text?: string }).text ?? '')
            } catch {
              text = ''
            }
          }
          out.push({
            messageId: String(m.message_id ?? ''),
            chatId: String(m.chat_id ?? chatId),
            openId: String(sender.open_id ?? sender.user_id ?? ''),
            senderType: String(sender.sender_type ?? ''),
            text,
            createTimeMs: Number(m.create_time ?? '0') || 0,
          })
        }
        if (data?.has_more !== true || data.page_token === undefined) break
        pageToken = data.page_token
      }
      return out
    },
  }
}
