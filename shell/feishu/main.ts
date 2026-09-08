// ============================================================
// shell/feishu/main.ts —— 飞书 shell 装配入口（与 cli/webui 平级的第三宿主）
//
// 扮演模型：根（user#0）是面板不跑 LLM 轮 → 单聊默认对象 = 船长名下的**接待员实例**
// （内置 assistant 占位类，族谱挂根）。飞书消息 = 船长的话（pilot 自根
// 身份投递），接待员回船长的信 = 读 aloud 给主人；审批申请经交互卡三按钮远程
// 裁决（→ pilot.replyAccess）。一切决策在 router.ts（纯逻辑可测），本文件只做
// 接线与动作执行。core 零改动。
//
// 运行：FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx npm run feishu [空间路径]
// ============================================================

import { resolve } from 'node:path'
import { bootStem } from '../cli/platform'
import { ROOT_ID } from '../../src/core/kernel'
import type { PilotEvent } from '../../src/core/events'
import { loadFeishuConfig } from './config'
import { createFeishuPlatform } from './feishu'
import {
  createRouterState,
  handleInbound,
  routeUserMail,
  applyWatchCommand,
  parseCardAction,
  formatTree,
  HELP_TEXT,
  type AccessRequestView,
  type MailItem,
  type OutAction,
} from './router'
import { approvalCard, approvalDecidedCard } from './cards'

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', String(reason))
})

const appId = process.env.FEISHU_APP_ID ?? ''
const appSecret = process.env.FEISHU_APP_SECRET ?? ''
if (appId === '' || appSecret === '') {
  console.error('[feishu-shell] 缺 FEISHU_APP_ID / FEISHU_APP_SECRET 环境变量（密钥永不进配置文件）')
  process.exit(1)
}

// 空间定位与 cli/webui 同律：首个非 flag 参数 > STEM_PROJECT_ROOT > cwd。
const positional = process.argv.slice(2).find((a) => !a.startsWith('-'))
const PROJECT_ROOT = resolve(positional ?? process.env.STEM_PROJECT_ROOT ?? process.cwd())

async function main(): Promise<void> {
  const config = loadFeishuConfig(PROJECT_ROOT)
  const { system, source } = await bootStem({ projectRoot: PROJECT_ROOT })
  console.log(`[feishu-shell] 空间=${PROJECT_ROOT} 网关=${source}`)

  const platform = createFeishuPlatform(appId, appSecret)
  const state = createRouterState(config)
  const cardOfRequest = new Map<string, { messageId: string; request: AccessRequestView }>()

  // —— 接待员：解析或创建（族谱挂根，内置 assistant 占位类起步） ——
  state.secretaryId = await resolveSecretary()
  console.log(`[feishu-shell] 接待员=${state.secretaryId}（主人 open_id 白名单 ${config.ownerOpenIds.length} 人）`)

  // —— watch 推送聚合（节流窗内同 chat 多条并一条，避免撞 5 QPS） ——
  const pending = new Map<string, string[]>()
  let flushTimer: NodeJS.Timeout | undefined
  const push = (chatId: string, text: string): void => {
    let arr = pending.get(chatId)
    if (arr === undefined) {
      arr = []
      pending.set(chatId, arr)
    }
    arr.push(text)
    if (flushTimer === undefined) {
      flushTimer = setTimeout(() => {
        flushTimer = undefined
        for (const [chat, texts] of pending) {
          platform.sendText(chat, texts.join('\n---\n')).catch((e) => console.error('[feishu-shell] watch 推送失败', String(e)))
        }
        pending.clear()
      }, Math.max(200, config.watchThrottleMs))
    }
  }

  // —— 入站：飞书消息 → router 决策 → 动作执行 ——
  platform.onMessage((msg) => {
    void execute(handleInbound(state, msg)).catch((e) => console.error('[feishu-shell] 入站处理失败', String(e)))
  })

  // —— 出站：内核事件流 ——
  system.pilot.subscribe((ev: PilotEvent) => {
    if (ev.type === 'letter' && ev.agentId === ROOT_ID) {
      // 根信箱新来信：反查 StoredMessage.from → 读 aloud / 审批分流。
      const rows = [...system.kernel.repository.list(ROOT_ID)].reverse()
      const mails: MailItem[] = ev.letters.map((letter) => {
        const content = String(letter.content)
        return { from: rows.find((r) => String(r.message.content) === content)?.from ?? '', content }
      })
      void execute(routeUserMail(state, mails)).catch((e) => console.error('[feishu-shell] 来信分流失败', String(e)))
      return
    }
    const agentId = 'agentId' in ev ? String(ev.agentId) : ''
    const desc =
      ev.type === 'status'
        ? `[${agentId}] 状态 ${ev.from} → ${ev.to}`
        : ev.type === 'notice'
          ? `[notice] ${ev.message}`
          : ev.type === 'letter'
            ? `[${agentId}] 收信 x${ev.letters.length}`
            : null
    if (desc === null || agentId === '') return
    for (const chat of chatsWatching(state, agentId)) push(chat, desc)
  })

  // —— 审批卡回调：owner 点击 → access_reply → 卡片原地更新留档 ——
  platform.onCardAction((ev) => {
    void (async () => {
      if (!config.ownerOpenIds.includes(ev.openId)) return
      const view = parseCardAction(ev.value)
      if (view === undefined) return
      await system.pilot.replyAccess({ requestId: view.requestId, reply: view.reply })
      const held = cardOfRequest.get(view.requestId)
      if (held !== undefined) {
        await platform.updateCard(ev.messageId === '' ? held.messageId : ev.messageId, approvalDecidedCard(held.request, view.reply))
      }
      console.log(`[feishu-shell] 审批 ${view.requestId} → ${view.reply}（飞书裁决）`)
    })().catch((e) => console.error('[feishu-shell] 卡片裁决失败', String(e)))
  })

  await platform.start()
  console.log('[feishu-shell] 长连接已启动（断线 SDK 自动重连），等待消息…')

  // —— 动作执行 ——
  async function execute(actions: readonly OutAction[]): Promise<void> {
    for (const action of actions) {
      try {
        switch (action.kind) {
          case 'reply':
            await platform.sendText(action.chatId, action.text)
            break
          case 'deliver':
            await system.pilot.sendMessage(action.to, action.text)
            break
          case 'approvalCard':
            for (const chatId of action.chatIds) {
              const messageId = await platform.sendCard(chatId, approvalCard(action.request))
              cardOfRequest.set(action.request.requestId, { messageId, request: action.request })
            }
            break
          case 'command':
            await platform.sendText(action.chatId, await runCommand(action.name, action.args, action.chatId))
            break
        }
      } catch (e) {
        console.error(`[feishu-shell] 动作 ${action.kind} 失败`, String(e))
      }
    }
  }

  async function runCommand(name: string, args: readonly string[], chatId: string): Promise<string> {
    switch (name) {
      case 'tree': {
        const agents = await system.pilot.listAgents()
        return formatTree(agents.map((a) => ({ id: a.id, name: a.name, classRef: String(a.classRef), parentId: a.parentId ?? '', status: a.status, turnCount: a.turnCount })))
      }
      case 'status': {
        const target = args[0] ?? state.secretaryId
        try {
          const a = await system.pilot.inspect(target)
          const facts = system.kernel.contextManager.boxFacts(a.id)
          return [
            `agent ${a.id}（${String(a.classRef)}，父=${a.parentId ?? '∅'}）`,
            `状态=${a.status} 轮数=${a.turnCount} 模型=${a.model ? `${a.model.provider}/${a.model.id}` : '继承链'}`,
            facts
              ? `生效接线：策略=${facts.strategy} 组装=${facts.assemble} custom=[${facts.customKeys.join(',')}] 倒计时=${facts.sendCountdownMs}ms`
              : '（无活动箱）',
          ].join('\n')
        } catch {
          return `找不到实例 [${target}]——/tree 看族谱。`
        }
      }
      case 'logs': {
        const target = args[0] ?? state.secretaryId
        const n = Number(args[1] ?? '10')
        const all = system.kernel.logger.query({})
        const mine = target === 'all' ? all : all.filter((e) => {
          const a = (e as { agentId?: unknown }).agentId
          const f = (e as { from?: unknown; to?: unknown }).from
          const t = (e as { from?: unknown; to?: unknown }).to
          return a === target || f === target || t === target
        })
        const tail = mine.slice(-(Number.isFinite(n) ? Math.max(1, n) : 10))
        if (tail.length === 0) return `agent [${target}] 暂无运行账。`
        return tail
          .map((e) => `- ${new Date((e as { at: number }).at).toISOString().slice(11, 19)} ${e.type} ${String((e as { message?: string }).message ?? '')}`)
          .join('\n')
      }
      case 'watch':
      case 'unwatch': {
        if (name === 'watch' && args[0] !== undefined && args[0] !== 'all') {
          const agents = await system.pilot.listAgents()
          if (!agents.some((a) => a.id === args[0])) return `没有实例 [${args[0]}]——/tree 看族谱。`
        }
        return applyWatchCommand(state, chatId, name as 'watch' | 'unwatch', args)
      }
      case 'stop': {
        if (args[0] === undefined) return '用法：/stop <agent>'
        await system.pilot.interrupt(args[0])
        return `已请求中断 [${args[0]}]。`
      }
      default:
        return HELP_TEXT
    }
  }

  async function resolveSecretary(): Promise<string> {
    const agents = await system.pilot.listAgents()
    const found = agents.find((a) => String(a.classRef) === config.secretaryClass && a.parentId === ROOT_ID)
    if (found !== undefined) return found.id
    return await system.pilot.instantiate(
      {
        className: config.secretaryClass,
        userPrompt: '（飞书 shell 启动信）你是船长的接待员：主人经飞书来的话都由你转达与办理，能自己办的就办公，办不了的如实说。回话保持简洁（会被原样读给主人）。',
      },
      PROJECT_ROOT,
    )
  }
}

function chatsWatching(state: { watches: Map<string, Set<string>> }, agentId: string): string[] {
  const chats: string[] = []
  for (const [chatId, set] of state.watches) {
    if (set.has(agentId) || set.has('*')) chats.push(chatId)
  }
  return chats
}

void main().catch((e) => {
  // core 错误是判别对象非 Error——String() 会吞成 [object Object]（实测教训）。
  console.error('[feishu-shell] 启动失败:', e instanceof Error ? e.stack ?? e.message : JSON.stringify(e))
  process.exit(1)
})
