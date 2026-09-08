// ============================================================
// shell/feishu/router.ts —— 飞书 shell 的纯逻辑核心（零 SDK 依赖，可全量单测）
//
// 职责（一切决策在此，main.ts 只做接线）：
//   1. 身份闸门：owner 白名单之外零服务（权限由族谱树定义，不由聊天渠道定义）；
//   2. 命令面：/help /new /use /exit /agents /tree /status /logs /watch /unwatch /stop；
//   3. 会话模型（显式目标制）：chat_id → 当前目标优先级 = 显式会话(/new /use，
//      回写 feishu.jsonc) > 静态绑定表 > 秘书（可选项，secretaryClass 配了才有）；
//      未绑定且秘书关闭 = 回指令指引；
//   4. 信箱读 aloud：根来信（接待员回复/审批申请）→ 出口消息/审批卡；
//   5. watch 订阅：任意 chat 订阅任意 agent 的 letter/status 事件（节流聚合）；
//   6. 幂等去重：平台事件有重试，message_id LRU 判重（手册 §8 硬建议）。
// ============================================================

import type { FeishuConfig } from './config'

// —— 入站形状（main.ts 从飞书事件规一化而来） ——

export interface InboundMsg {
  readonly messageId: string
  readonly chatId: string
  readonly chatType: 'p2p' | 'group'
  readonly openId: string
  readonly text: string
}

// —— 出站动作（main.ts 执行；router 不触网） ——

export type OutAction =
  | { readonly kind: 'reply'; readonly chatId: string; readonly text: string }
  /** 信件正文投给目标 agent（pilot.sendMessage 自根身份）。 */
  | { readonly kind: 'deliver'; readonly chatId: string; readonly to: string; readonly text: string }
  /** 发送审批交互卡（targets = 主人单聊 + approvalChatIds）。 */
  | { readonly kind: 'approvalCard'; readonly chatIds: readonly string[]; readonly request: AccessRequestView }
  /** 命令执行请求（main 持 pilot/kernel 能力面执行，产出文本后回 reply）。 */
  | { readonly kind: 'command'; readonly chatId: string; readonly name: string; readonly args: readonly string[] }

/** access_request XML 的解析视图。 */
export interface AccessRequestView {
  readonly requestId: string
  readonly accessKey: string
  /** 申请者全名 `name#id`（B3 呈现面；审批卡直读，回投以 requestId 配对）。 */
  readonly agentId: string
  readonly detail: string
}

/** 内核信箱来信的规一形状（main 用 repository 反查 from 后送入）。 */
export interface MailItem {
  readonly from: string
  readonly content: string
}

export interface RouterState {
  readonly config: FeishuConfig
  /** 本进程接待员实例 id（main 启动期解析/创建后注入；秘书关闭 = ''）。 */
  secretaryId: string
  /** 主人默认单聊（首次 owner 来话自动记录 —— 审批卡/读 aloud 的缺省投递面）。 */
  ownerChatId: string | undefined
  /** 显式会话目标：chat_id → agent id（feishu.jsonc sessions 的内存镜像）。 */
  readonly chatTargets: Map<string, string>
  /** 会话态回写钩子（main 注入：patchFeishuConfig 定点写 jsonc）。 */
  readonly hooks: RouterHooks
  /** watch 订阅：chat_id → 订阅的 agent id 集（'*' = 全生态）。 */
  readonly watches: Map<string, Set<string>>
  /** message_id 去重（LRU 上限）。 */
  readonly seen: Set<string>
  /** 已答复审批（requestId → 裁决词，卡片状态更新用）。 */
  readonly answered: Map<string, string>
}

const SEEN_MAX = 500

/** 会话态持久化钩子（全部可选——纯逻辑单测不注入即可跑）。 */
export interface RouterHooks {
  /** /new /use /exit 变更当前目标。 */
  readonly onSession?: (chatId: string, target: string | null) => void
  /** owner p2p 会话识别（上线/离线通知投递面）。 */
  readonly onOwnerChat?: (chatId: string) => void
  /** 某会话已处理到该时刻（断线补偿增量起点）。 */
  readonly onSeen?: (chatId: string, atMs: number) => void
}

export function createRouterState(config: FeishuConfig, hooks: RouterHooks = {}): RouterState {
  return {
    config,
    secretaryId: '',
    ownerChatId: config.ownerChatId !== '' ? config.ownerChatId : undefined,
    chatTargets: new Map(Object.entries(config.sessions)),
    hooks,
    watches: new Map(),
    seen: new Set(),
    answered: new Map(),
  }
}

/** 设定/解除本会话当前目标（内存镜像 + 回写钩子）。 */
export function setSessionTarget(state: RouterState, chatId: string, target: string | null): void {
  if (target === null) state.chatTargets.delete(chatId)
  else state.chatTargets.set(chatId, target)
  state.hooks.onSession?.(chatId, target)
}

/** 入站处理总入口：去重 → 身份闸门 → 命令/信件分流。 */
export function handleInbound(state: RouterState, msg: InboundMsg): OutAction[] {
  if (state.seen.has(msg.messageId)) return []
  state.seen.add(msg.messageId)
  if (state.seen.size > SEEN_MAX) {
    // 简易 LRU：丢最早一半（插入序近似）。
    const half = Math.floor(SEEN_MAX / 2)
    let i = 0
    for (const id of state.seen) {
      if (i++ >= half) break
      state.seen.delete(id)
    }
  }

  const isOwner = state.config.ownerOpenIds.includes(msg.openId)
  if (!isOwner) {
    // 白名单外零服务；owner 未配置时给认领指引（打印 open_id，人工回填后重启）。
    if (state.config.ownerOpenIds.length === 0) {
      return [{
        kind: 'reply',
        chatId: msg.chatId,
        text: `暂未认领主人身份。你的 open_id 是 ${msg.openId} —— 把它写进 .stem/feishu.jsonc 的 ownerOpenIds 并重启 feishu shell 即可开通。`,
      }]
    }
    console.log(`[feishu] 拒服非主人消息 open_id=${msg.openId} chat=${msg.chatId}`)
    return []
  }
  if (msg.chatType === 'p2p' && state.ownerChatId !== msg.chatId) {
    state.ownerChatId = msg.chatId
    state.hooks.onOwnerChat?.(msg.chatId)
  }
  state.hooks.onSeen?.(msg.chatId, Date.now())

  const text = stripMentions(msg.text)
  if (text === '') return [{ kind: 'reply', chatId: msg.chatId, text: '（收到空消息；输入 /help 看可用指令）' }]
  if (text.startsWith('/')) return routeCommand(state, msg.chatId, text)
  const target = resolveTarget(state, msg)
  if (target === '') {
    return [{
      kind: 'reply',
      chatId: msg.chatId,
      text: '本会话还没有目标 agent。\n/agents 看可对话的实例，/use <name|id> 选定，/new <类> [任务] 现场创建；/help 看全部指令。',
    }]
  }
  return [{ kind: 'deliver', chatId: msg.chatId, to: target, text }]
}

/** 剔除群聊 @ 占位（`@_user_1` 等，手册坑 4）。 */
export function stripMentions(text: string): string {
  return text.replace(/@_user_\d+\s*/g, '').trim()
}

/**
 * chat → 目标 agent（显式会话制优先级）：
 * 会话当前目标（/new /use）> 静态绑定表 > 秘书（secretaryClass 配置了才存在，可选项）。
 */
export function resolveTarget(state: RouterState, msg: InboundMsg): string {
  return state.chatTargets.get(msg.chatId)
    ?? state.config.chatBindings[msg.chatId]
    ?? (msg.chatType === 'p2p' ? state.secretaryId : '')
}

function routeCommand(state: RouterState, chatId: string, text: string): OutAction[] {
  const [head, ...args] = text.slice(1).split(/\s+/)
  const name = (head ?? '').toLowerCase()
  switch (name) {
    case 'help':
      return [{ kind: 'reply', chatId, text: HELP_TEXT }]
    case 'exit': {
      if (!state.chatTargets.has(chatId)) return [{ kind: 'reply', chatId, text: '本会话没有已绑定的目标（秘书/绑定表模式未变）。' }]
      setSessionTarget(state, chatId, null)
      return [{ kind: 'reply', chatId, text: '已解绑本会话目标。' + (state.config.secretaryClass !== '' ? '（回落接待员）' : '（后续消息需先 /use 或 /new）') }]
    }
    case 'new':
    case 'use':
    case 'agents':
    case 'tree':
    case 'status':
    case 'logs':
    case 'watch':
    case 'unwatch':
    case 'stop':
      return [{ kind: 'command', chatId, name, args }]
    default:
      return [{ kind: 'reply', chatId, text: `未知指令 /${name}——输入 /help 看可用指令。` }]
  }
}

export const HELP_TEXT = [
  'stem 飞书助理 · 可用指令：',
  '/new <类> [任务] — 创建实例并设为本会话当前目标',
  '/use <name|id> — 切换本会话目标（name、name#id、id 或唯一前缀均可）',
  '/agents — 可对话实例清单（选人面板）',
  '/exit — 解绑本会话目标',
  '/tree — 族谱树与各 agent 状态',
  '/status [agent] — 实例详情（缺省接待员）',
  '/logs [agent] [n] — 最近 n 条运行账（默认 10）',
  '/watch <agent|all> — 订阅该 agent 事件推送到本会话',
  '/unwatch [agent|all] — 退订（无参 = 全退）',
  '/stop <agent> — 中断在途轮',
  '其余文本 = 交给本会话当前目标（/use /new 设定；静态绑定/秘书为兜底）。',
].join('\n')

// —— 信箱读 aloud（根来信 → 出口） ——

/** 解析根信箱来信里的审批申请（XML 形状 = formatAccessRequest 产物）。 */
export function parseAccessRequest(text: string): AccessRequestView | undefined {
  const m = /<access_request\s+id="([^"]+)"\s+accessKey="([^"]+)"\s+agent="([^"]+)">/.exec(text)
  if (!m) return undefined
  return {
    requestId: m[1]!,
    accessKey: m[2]!,
    agentId: m[3]!,
    detail: text.slice(m[0].length).split('</access_request>')[0] ?? '',
  }
}

/**
 * 根（user#0）新来信 → 出口动作：审批申请发卡（附状态行文本兜底），其余按来信身份分流——
 * 接待员（或绑定 agent）回给船长的信 = 读 aloud 给主人；旁支通信不打扰主人，仅走 watch。
 */
export function routeUserMail(state: RouterState, mail: readonly MailItem[]): OutAction[] {
  const out: OutAction[] = []
  const ownerChat = state.ownerChatId
  if (ownerChat === undefined) return []
  for (const item of mail) {
    const req = parseAccessRequest(item.content)
    if (req !== undefined) {
      const targets = [ownerChat, ...state.config.approvalChatIds.filter((c) => c !== ownerChat)]
      out.push({ kind: 'approvalCard', chatIds: targets, request: req })
      continue
    }
    if (item.from === state.secretaryId || isBoundSource(state, item.from)) {
      out.push({ kind: 'reply', chatId: ownerChat, text: item.content })
    }
    // 其余（如根自身 assistant 回声/旁支）不读 aloud。
  }
  return out
}

function isBoundSource(state: RouterState, agentId: string): boolean {
  return Object.values(state.config.chatBindings).includes(agentId)
}

// —— 断线补偿（重连后按 chat 拉取增量消息的回放计划） ——

/** im.v1.message.list 单条的规一形状（main 从 SDK 响应提取；router 不触网）。 */
export interface FetchedMsg {
  readonly messageId: string
  readonly chatId: string
  readonly openId: string
  readonly senderType: string
  readonly text: string
  readonly createTimeMs: number
}

/**
 * 拉取消息 → 可回放信（纯函数，去重与过滤全部复用入站律）：
 * 仅真人 + owner 白名单 + message_id 未见（handleInbound 的 LRU 是最终闸）；
 * API 倒序返回 → 按时间升序重放（顺序 = 主人说话顺序）。
 */
export function planReplay(state: RouterState, fetched: readonly FetchedMsg[]): InboundMsg[] {
  const fresh = fetched.filter(
    (f) => f.senderType === 'person' && state.config.ownerOpenIds.includes(f.openId) && !state.seen.has(f.messageId),
  )
  return [...fresh]
    .sort((a, b) => a.createTimeMs - b.createTimeMs)
    .map((f) => ({ messageId: f.messageId, chatId: f.chatId, chatType: f.chatId === state.ownerChatId ? 'p2p' as const : 'group' as const, openId: f.openId, text: f.text }))
}

// —— watch 路由 ——

/** 本 chat 是否订阅了该 agent（含 'all' 通配）。 */
export function watchesFor(state: RouterState, agentId: string): string[] {
  const chats: string[] = []
  for (const [chatId, set] of state.watches) {
    if (set.has(agentId) || set.has('*')) chats.push(chatId)
  }
  return chats
}

export function applyWatchCommand(state: RouterState, chatId: string, name: 'watch' | 'unwatch', args: readonly string[]): string {
  const target = args[0]
  const set = state.watches.get(chatId) ?? new Set<string>()
  state.watches.set(chatId, set)
  if (name === 'unwatch') {
    if (target === undefined) {
      set.clear()
      return '已退订本会话的全部 watch。'
    }
    set.delete(target === 'all' ? '*' : target)
    return `已退订 [${target}]。`
  }
  if (target === undefined) return '用法：/watch <agent|all>'
  set.add(target === 'all' ? '*' : target)
  return `本会话已订阅 [${target}] 的事件推送（/unwatch 退订）。`
}

// —— 审批卡回调 → access_reply 输入 ——

/** 卡片按钮 value 约定：{act:'access', reply:'once|always|reject', requestId}。 */
export interface CardActionView {
  readonly requestId: string
  readonly reply: 'once' | 'always' | 'reject'
}

export function parseCardAction(value: unknown): CardActionView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (v.act !== 'access') return undefined
  const reply = v.reply
  if (reply !== 'once' && reply !== 'always' && reply !== 'reject') return undefined
  if (typeof v.requestId !== 'string' || v.requestId === '') return undefined
  return { requestId: v.requestId, reply }
}

// —— 文本渲染（纯函数，输入为 main 投影出的平数据） ——

export interface TreeRow {
  /** 全局称呼（B2/B3 呈现面 name#id；缺位回落裸 id）。 */
  readonly name?: string
  readonly id: string
  readonly classRef: string
  readonly parentId: string
  readonly status: string
  readonly turnCount: number
}

/** /tree 渲染：根起缩进树 + 状态徽标（呈现面 name#id）。 */
export function formatTree(agents: readonly TreeRow[]): string {
  const badge: Record<string, string> = { idle: '🟢', thinking: '🔵', holding: '🟡', interrupted: '⚪' }
  const children = new Map<string, TreeRow[]>()
  for (const a of agents) {
    const list = children.get(a.parentId) ?? []
    children.set(a.parentId, [...list, a])
  }
  const root = agents.find((a) => a.parentId === '')
  const lines: string[] = [`👤 ${root?.name ?? 'user'}#0 (根)`]
  const walk = (parent: string, depth: number): void => {
    for (const a of (children.get(parent) ?? []).slice().sort((x, y) => x.id.localeCompare(y.id))) {
      lines.push(`${'  '.repeat(depth)}${badge[a.status] ?? '❓'} ${a.name ? a.name + '#' : ''}${a.id} (${a.classRef}, ${a.status}, ${a.turnCount}轮)`)
      walk(a.id, depth + 1)
    }
  }
  walk('0', 1)
  if (lines.length === 1) lines.push('  （旗下暂无实例）')
  return lines.join('\n')
}

/** 飞书文本消息长度防护：超长按行分箱（1500 字符/条，单行超限硬切）。 */
export function splitForChat(text: string, limit = 1500): string[] {
  const t = text.trim() === '' ? '（空回复）' : text
  if (t.length <= limit) return [t]
  const out: string[] = []
  let buf = ''
  const flush = (): void => {
    if (buf !== '') {
      out.push(buf)
      buf = ''
    }
  }
  for (const line of t.split('\n')) {
    if (line.length > limit) {
      flush()
      for (let i = 0; i < line.length; i += limit) out.push(line.slice(i, i + limit))
      continue
    }
    if (buf.length + line.length + 1 > limit) flush()
    buf = buf === '' ? line : `${buf}\n${line}`
  }
  flush()
  return out
}
