// ============================================================
// shell/feishu/main.ts —— 飞书 shell 装配入口（与 cli/webui 平级的第三宿主）
//
// 扮演模型（CLI 式显式会话）：根（user#0）是面板不跑 LLM 轮 → 每个会话有
// **当前目标 agent**（/new /use /exit 维护，回写 .stem/feishu.jsonc）；静态
// 绑定表与接待员（secretaryClass 可选项）只是未绑定时的兜底。飞书消息 =
// 船长的话（pilot 自根身份投递给目标），目标回根的信 = 读 aloud 给主人；
// 审批申请经交互卡三按钮远程裁决（→ pilot.replyAccess）。连接就绪发"上线"、
// SIGTERM 优雅发"离线"；重连后按会话拉取增量消息补偿（根的答复义务不因
// 链路中断豁免）。一切决策在 router.ts（纯逻辑可测），本文件只做接线与
// 动作执行。core 零改动。
//
// 运行：FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx npm run feishu [空间路径]
// ============================================================

import { resolve } from 'node:path'
import { bootStem } from '../cli/platform'
import { ROOT_ID } from '../../src/core/kernel'
import type { PilotEvent } from '../../src/core/events'
import { loadFeishuConfig, patchFeishuConfig } from './config'
import { createFeishuPlatform } from './feishu'
import {
  createRouterState,
  handleInbound,
  planReplay,
  routeUserMail,
  applyWatchCommand,
  parseCardAction,
  setSessionTarget,
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
  // 会话态回写（jsonc 定点编辑，保用户注释）。
  const state = createRouterState(config, {
    onSession: (chatId, target) => {
      try { patchFeishuConfig(PROJECT_ROOT, { kind: 'session', chatId, target }) } catch (e) { console.error('[feishu-shell] 会话回写失败', String(e)) }
    },
    onOwnerChat: (chatId) => {
      try { patchFeishuConfig(PROJECT_ROOT, { kind: 'ownerChat', chatId }) } catch (e) { console.error('[feishu-shell] ownerChat 回写失败', String(e)) }
    },
    onSeen: (chatId, at) => {
      try { patchFeishuConfig(PROJECT_ROOT, { kind: 'seen', chatId, at }) } catch { /* 高频面：静默（下次必达） */ }
    },
  })
  const cardOfRequest = new Map<string, { messageId: string; request: AccessRequestView }>()

  // —— 接待员（可选项：secretaryClass='' = 关闭秘书中转） ——
  if (config.secretaryClass !== '') {
    state.secretaryId = await resolveSecretary()
    console.log(`[feishu-shell] 接待员=${state.secretaryId}（秘书模式开启）`)
  }
  console.log(`[feishu-shell] 主人白名单 ${config.ownerOpenIds.length} 人，显式会话 ${state.chatTargets.size} 个`)

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

  // —— 上线通知（主人会话已知才发）与断线补偿（离线期间的信不丢） ——
  if (state.ownerChatId !== undefined) {
    await platform.sendText(state.ownerChatId, '🔵 stem 上线了（长连接就绪）。离线期间的消息将自动补收。').catch(() => {})
  }
  await compensate()

  // —— SIGTERM/SIGINT：优雅离线（先告知主人，再退场） ——
  let shuttingDown = false
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      if (shuttingDown) return
      shuttingDown = true
      const bye = state.ownerChatId !== undefined
        ? platform.sendText(state.ownerChatId, '⚫ stem 离线了（进程收到 ' + sig + '，在途工作已尽力收尾）。').catch(() => {})
        : Promise.resolve()
      void bye.finally(() => process.exit(0))
      setTimeout(() => process.exit(0), 5000).unref()
    })
  }

  /** 断线补偿：对全部已知会话（主人 + 有目标的 + 有历史的）按 lastSeenAt 增量拉取重放。 */
  async function compensate(): Promise<void> {
    const chats = new Set<string>([...state.chatTargets.keys()])
    if (state.ownerChatId !== undefined) chats.add(state.ownerChatId)
    for (const [chat, bound] of Object.entries(config.chatBindings)) {
      if (bound !== '') chats.add(chat)
    }
    for (const [chat] of Object.entries(config.lastSeenAt)) chats.add(chat)
    for (const chat of chats) {
      try {
        // 起点回退 5s（inclusive API 边界与毫秒取整的宽容带；seen LRU 兜底去重）。
        const after = Math.max(0, (config.lastSeenAt[chat] ?? 0) - 5000)
        const fetched = await platform.listMessages(chat, after, 100)
        const replay = planReplay(state, fetched)
        if (replay.length === 0) continue
        console.log(`[feishu-shell] 补偿重放 chat=${chat} x${String(replay.length)}`)
        for (const msg of replay) {
          await execute(handleInbound(state, msg))
        }
      } catch (e) {
        console.error(`[feishu-shell] 补偿失败 chat=${chat}`, String(e))
      }
    }
  }

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

  /** 三形态寻址（name / name#id / 唯一 id 前缀 / 精确 id），歧义与缺失渲染成可读回报。 */
  function resolveRef(ref: string): string | undefined {
    try {
      return system.kernel.resolveAgent(ref)
    } catch (e) {
      const err = e as { kind?: string; candidates?: string[] }
      if (err.kind === 'agent_ref_ambiguous') {
        const list = (err.candidates ?? []).map((id) => system.kernel.displayOf(id)).join('、')
        throw new Error(`[${ref}] 有歧义：${list}——用全名或更长的 id 前缀。`)
      }
      return undefined
    }
  }

  async function runCommand(name: string, args: readonly string[], chatId: string): Promise<string> {
    switch (name) {
      case 'new': {
        const className = args[0]
        if (className === undefined) return '用法：/new <类> [任务文字]'
        const task = args.slice(1).join(' ')
        try {
          const id = await system.pilot.instantiate(
            { className, userPrompt: task === '' ? `（飞书会话开工信）你是本会话的目标 agent，主人经飞书直连指挥你，用一句话确认就位。` : task },
            PROJECT_ROOT,
          )
          setSessionTarget(state, chatId, id)
          return `已创建并绑定本会话目标：${system.kernel.displayOf(id)}（/use 可切换，/exit 解绑）`
        } catch (e) {
          const err = e as { kind?: string; message?: string }
          return `创建失败：${err.kind === 'template_not_found' || err.kind === 'agent_class_not_found' ? `没有类 [${className}]——/tree 看类表` : JSON.stringify(e)}`
        }
      }
      case 'use': {
        const ref = args[0]
        if (ref === undefined) return '用法：/use <name|name#id|id|唯一前缀>'
        let id: string | undefined
        try {
          id = resolveRef(ref)
        } catch (e) {
          return (e as Error).message
        }
        if (id === undefined) return `找不到实例 [${ref}]——/agents 看清单。`
        setSessionTarget(state, chatId, id)
        return `本会话目标 → ${system.kernel.displayOf(id)}`
      }
      case 'agents': {
        const agents = await system.pilot.listAgents()
        if (agents.length === 0) return '生态还没有实例（/new <类> [任务] 现场创建一个）。'
        const badge: Record<string, string> = { idle: '🟢', thinking: '🔵', holding: '🟡', interrupted: '⚪' }
        const cur = state.chatTargets.get(chatId)
        return ['可对话实例（/use <name|id> 选定）：', ...agents.map((a) => {
          const full = system.kernel.displayOf(a.id)
          return `${a.id === cur ? '▶' : ' '} ${badge[a.status] ?? '❓'} ${full}（${String(a.classRef)}）`
        })].join('\n')
      }
      case 'tree': {
        const agents = await system.pilot.listAgents()
        return formatTree(agents.map((a) => ({ id: a.id, name: a.name, classRef: String(a.classRef), parentId: a.parentId ?? '', status: a.status, turnCount: a.turnCount })))
      }
      case 'status': {
        const target = (args[0] !== undefined ? resolveRef(args[0]) ?? args[0] : undefined) ?? state.secretaryId
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
        const target = (args[0] !== undefined && args[0] !== 'all' ? resolveRef(args[0]) ?? args[0] : undefined) ?? state.secretaryId
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
          const resolved = resolveRef(args[0])
          if (resolved === undefined) return `没有实例 [${args[0]}]——/agents 看清单。`
          return applyWatchCommand(state, chatId, 'watch', [resolved])
        }
        return applyWatchCommand(state, chatId, name as 'watch' | 'unwatch', args)
      }
      case 'stop': {
        if (args[0] === undefined) return '用法：/stop <agent>'
        const target = resolveRef(args[0])
        if (target === undefined) return `找不到实例 [${args[0]}]——/agents 看清单。`
        await system.pilot.interrupt(target)
        return `已请求中断 [${system.kernel.displayOf(target)}]。`
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
