// ============================================================
// shell/webui/view.js —— WebUI 视图纯函数核心（S6 批 2，R8/R9）
//
// 零 DOM（浏览器经 <script type="module"> import；node:test 直测）。
// 承载八组纯逻辑：
//   1. 汉字字形表（R8：禁 emoji/几何字符，状态/动作全汉字）+ 三态语义；
//   2. 信箱归位 routeLetters（R9 第一视角：根非对话窗口，来信按
//      <sender> 反查归位各 agent 窗）；
//   3. git 风族谱行序 computeTreeRows（DFS + 泳道 + 溢出折叠）；
//   4. 按钮可用性 deriveActions（能力数据驱动，非 agent 特判——
//      根不可销毁等事实全部来自族谱位置，seed #5 就此消除）；
//   5. 流式 live 桶 reducer applyStreamEvent（delta live-only，快照收口）；
//   6. 思维链折叠 reasoningView（running 追最新行 / 结束定格首行）；
//   7. 上下文占用 contextRatio + ratioTone（底部进度条数据层）；
//   8. 零依赖 markdown 子集渲染 mdToHtml（先抽码后转义 = XSS 构造安全）；
//   9. 出生路径 id 自然序 idOrder（族谱显式排序）；
//  10. 二级操作菜单 menuItems / 信息卡 infoRows / 相对时间 relativeTime /
//      对话尾统计 turnStats（批 3：控件收进菜单、hover 详情、统计条——全数据驱动）。
// ============================================================

/** 本空间根（pilot 扮演身份的约定 id）。 */
export const ROOT_ID = '0'

// ---------- 1. 字形表（R8） ----------

/** 状态字形：静/思/持/断（idle/thinking/holding/interrupted）。 */
export const STATUS_GLYPH = {
  idle: '静',
  thinking: '思',
  holding: '持',
  interrupted: '断',
}

/** 动作字形：停/缩/毁/生/送/审/工/摘/我/模。 */
export const ACT_GLYPH = {
  interrupt: '停',
  compact: '缩',
  terminate: '毁',
  spawn: '生',
  send: '送',
  review: '审',
  tool: '工',
  summary: '摘',
  me: '我',
  model: '模',
}

export const statusGlyph = (status) => STATUS_GLYPH[status] ?? '·'

/** 三态视觉（R8）：off=不可用（遮罩）/ ready=可用（白边框）/ active=激活（荧光）。 */
export const statusTone = (status) =>
  status === 'thinking' || status === 'holding' ? 'active' : status === 'interrupted' ? 'alert' : 'ready'

// ---------- 2. 信箱文本（sender 归位原料） ----------

/** 剥发送者戳：`<sender id="name#id" at="yymmdd.hhmm">…</sender>` → {sender, text}。 */
export function stripSender(raw) {
  const m = /^<sender id="([^"]+)"(?: at="[^"]*")?>([\s\S]*?)<\/sender>$/.exec(String(raw ?? ''))
  if (m) return { sender: m[1] ?? '', text: m[2] ?? '' }
  return { sender: '', text: String(raw ?? '') }
}

/** 折叠空白并截断（侧栏行摘要用）。 */
export function truncate(text, max = 30) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max) + '…' : flat
}

/**
 * 信箱消息流 → 时间线渲染描述（R9 第一视角核心，纯函数）。
 * item = {kind:'msg'|'tool'|'meta'|'ask', side:'me'|'agent'|'them', who, text, icon}
 * - 常规 agent 窗：user 信按 sender 归位（我=根来信右侧；他 agent 来信左侧）；
 * - 根（user#0）窗：反相——assistant = 人类发言（右"我"），user = 后代回信（左）；
 * - access_request 来信不进时间线（归"审"面板），出 {kind:'ask'} 供计数；
 * - system 不上线；invalid（compact 归档）跳过；tag=summary 出中缝元条。
 */
export function routeLetters(messages, currentId, rootId = ROOT_ID) {
  const atRoot = currentId === rootId
  const items = []
  for (const m of messages ?? []) {
    if (!m.valid) continue
    if (m.tag === 'summary') { items.push({ kind: 'meta', icon: ACT_GLYPH.summary, text: '上下文摘要（compact 归档，原文保留可审计）' }); continue }
    const role = m.role
    if (role === 'system') continue
    if (role === 'tool') { items.push({ kind: 'tool', icon: ACT_GLYPH.tool, text: String(m.content ?? '') }); continue }
    if (role === 'user') {
      const { sender, text } = stripSender(m.content)
      if (text.trimStart().startsWith('<access_request')) { items.push({ kind: 'ask', icon: ACT_GLYPH.review, text }); continue }
      if (atRoot) {
        // 根箱的 user 信 = 后代回信（左）；无 sender 的历史遗留也按来信。
        items.push({ kind: 'msg', side: 'them', who: sender ? `来自 ${sender}` : '来信', text })
      } else {
        // 戳面 = name#id 全名（B4）：裸 id 或 id 尾段命中根都算己方来信。
        const mine = sender === '' || sender === rootId || sender.endsWith('#' + rootId)
        items.push({ kind: 'msg', side: mine ? 'me' : 'them', who: mine ? ACT_GLYPH.me : `来自 ${sender}`, text })
      }
      continue
    }
    if (role === 'assistant') {
      // 根窗：assistant = 人类（经 pilot）发言 = "我"；agent 窗：它自己的回复。
      items.push({ kind: 'msg', side: atRoot ? 'me' : 'agent', who: atRoot ? ACT_GLYPH.me : currentId, text: String(m.content ?? '') })
    }
  }
  return items
}

// ---------- 3. git 风族谱行序（DFS + 泳道 + 折叠） ----------

/** 家族分支色板（OLED 低饱和，仅两种主色交替 + 根灰）。 */
export const FAMILY_PALETTE = ['accent', 'muted', 'alert-soft']

/**
 * 族谱侧栏行序（纯函数，输入 /api/agents 行集）。
 * 行 = {type:'node', id, isRoot, depth, lane, parentLane, join（是否画父连线）,
 *       passThrough:[穿过本行的祖先泳道], family（家族色 index）, row:{...原 agent 数据}}
 *   或 {type:'more', count, kind:'depth'|'siblings', depth, lane}（折叠行「…+n」）。
 * 规则（s6-plan §2）：DFS 子序 = 出生序（输入行序）；深 > maxDepth 折叠后代；
 * 同父 > maxSiblings 折叠多余；lane 列 = 缩进深度；passThrough 供 SVG 竖线延续。
 */
export function computeTreeRows(agents, opts = {}) {
  const { maxDepth = 4, maxSiblings = 6, rootId = ROOT_ID } = opts
  const list = Array.isArray(agents) ? agents : []
  const byParent = new Map()
  for (const a of list) {
    const key = a.parentId ?? ''
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key).push(a)
  }
  const descendantCount = (id) => {
    let n = 0
    const stack = [id]
    while (stack.length > 0) {
      const cur = stack.pop()
      for (const child of byParent.get(cur) ?? []) { n++; stack.push(child.id) }
    }
    return n
  }
  const roots = list.filter((a) => (a.parentId ?? null) === null)
  // 约定根恒先行（其余无父行为防御性并列根）；同层按出生路径 id 自然序（显式声明，
  // 不依赖输入行序——批 3 项 3）。
  roots.sort((a, b) => (a.id === rootId ? -1 : b.id === rootId ? 1 : idOrder(a.id, b.id)))
  const rows = []
  // 每层记录本层节点的行号，供 passThrough 后处理：有下一兄弟 B 的节点 A，
  // A.lane 竖线在 (rowA, rowB) 开区间各行的背景继续（父泳道贯穿其子树行）。
  const walk = (nodes, depth, parentLane, family) => {
    const lane = depth
    const total = nodes.length
    const visible = total > maxSiblings ? nodes.slice(0, maxSiblings - 1) : nodes
    const levelRowIdx = []
    visible.forEach((node) => {
      levelRowIdx.push(rows.length)
      rows.push({
        type: 'node',
        id: node.id,
        isRoot: (node.parentId ?? null) === null,
        depth: lane,
        lane,
        parentLane,
        join: parentLane !== null,
        passThrough: [],
        family,
        row: node,
      })
      const children = (byParent.get(node.id) ?? []).slice().sort((x, y) => idOrder(x.id, y.id))
      if (children.length > 0) {
        if (depth + 1 > maxDepth) {
          rows.push({ type: 'more', kind: 'depth', count: descendantCount(node.id), depth: lane + 1, lane: lane + 1 })
        } else {
          walk(children, depth + 1, lane, family)
        }
      }
    })
    if (total > visible.length) {
      const hidden = total - visible.length
      let hiddenDescendants = 0
      for (const node of nodes.slice(visible.length)) hiddenDescendants += 1 + descendantCount(node.id)
      rows.push({ type: 'more', kind: 'siblings', count: hidden, descendants: hiddenDescendants, depth: lane, lane })
    }
    // 本层 passThrough 延伸：节点 i 有后继（下一兄弟或折叠 more），lane 背景线贯穿至其后继行前。
    for (let i = 0; i < levelRowIdx.length; i++) {
      const hasSuccessor = i + 1 < visible.length || total > visible.length
      if (!hasSuccessor) continue
      const rowA = levelRowIdx[i]
      const rowB = i + 1 < levelRowIdx.length ? levelRowIdx[i + 1] : rows.length // 折叠 more 收尾：延伸到末尾
      for (let k = rowA + 1; k < rowB; k++) {
        const r = rows[k]
        if (r.passThrough !== undefined && !r.passThrough.includes(lane)) r.passThrough.push(lane)
      }
    }
  }
  walk(roots, 0, null, -1)
  // 家族色：根的每个直接子树一族一色（顶层支系交替，深层沿用）。
  let seq = 0
  for (const r of rows) {
    if (r.type !== 'node') continue
    if (r.parentLane === null) r.family = -1 // 根/并列根 = 灰
    else if (r.depth === 1) r.family = seq++ % 2
  }
  return rows
}

// ---------- 4. 动作可用性（能力数据驱动，无 agent 特判） ----------

/**
 * 头部动作三态（R8）。事实全部来自族谱位置/面板属性，不认 agent id：
 * 根（parentId=null）天然无销毁者 → 毁 off；根面板不跑 LLM/不组装 → 停·缩 off。
 * 返回 {send, interrupt, compact, terminate, model}，值 ∈ 'off'|'ready'|'active'。
 */
export function deriveActions(agent) {
  if (agent === null || agent === undefined) {
    return { send: 'off', interrupt: 'off', compact: 'off', terminate: 'off', model: 'off' }
  }
  const isRoot = (agent.parentId ?? null) === null
  return {
    send: isRoot ? 'off' : 'active', // 根非对话窗口（R9）；选中 agent = 对话激活态
    interrupt: isRoot ? 'off' : 'ready',
    compact: isRoot ? 'off' : 'ready',
    terminate: isRoot ? 'off' : 'ready', // 根无祖先 → 销毁权不可达（kernel 同律，UI 只是如实呈现）
    model: 'ready', // 三环自由：任何节点均可设显式层（家学本体仍只经 config 改）
  }
}

// ---------- 5. 流式 live 层（delta = live-only，快照收口不补间隙——三源共识铁律） ----------

/** live 桶容器（agentId → {text, reasoning, tools, startedAt, lastAt}）。 */
export function createLiveBuckets() {
  return Object.create(null)
}

function ensureBucket(buckets, agentId) {
  let b = buckets[agentId]
  if (b === undefined) {
    b = buckets[agentId] = { text: '', reasoning: '', tools: [], startedAt: 0, lastAt: 0 }
  }
  return b
}

/**
 * PilotEvent（SSE JSON 形）→ live 桶就地更新（消费面窄：stream 的 text/reasoning
 * delta + tool 相位；其余事件类型恒穿越无副作用）。收口纪律：轮末快照
 * （letter → loadContext 重建历史）后由调用方 clearBucket——delta 掉了不补，
 * 快照自愈。tool PilotEvent 无 callId → 同名后进先匹配（并行同名=队尾先收口，
 * 已知简化；args 刻意不上广播，chip 只显名字/相位/耗时）。
 */
export function applyStreamEvent(buckets, ev) {
  if (ev === null || typeof ev !== 'object') return buckets
  const now = Date.now()
  if (ev.type === 'stream') {
    const e = ev.event ?? {}
    if (e.type === 'text-delta' || e.type === 'reasoning-delta') {
      const b = ensureBucket(buckets, String(ev.agentId))
      if (b.startedAt === 0) b.startedAt = now
      if (e.type === 'text-delta') b.text += String(e.text ?? '')
      else b.reasoning += String(e.text ?? '')
      b.lastAt = now
    }
    return buckets
  }
  if (ev.type === 'tool') {
    const b = ensureBucket(buckets, String(ev.agentId))
    const name = String(ev.tool ?? '?')
    const at = Number(ev.at) > 0 ? Number(ev.at) : now
    if (ev.phase === 'called') {
      b.tools.push({ name, phase: 'called', at, doneAt: 0 })
    } else {
      let matched = false
      for (let i = b.tools.length - 1; i >= 0; i--) {
        const t = b.tools[i]
        if (t.name === name && t.phase === 'called') {
          t.phase = ev.phase === 'error' ? 'error' : 'success'
          t.doneAt = at
          matched = true
          break
        }
      }
      if (!matched) b.tools.push({ name, phase: ev.phase === 'error' ? 'error' : 'success', at, doneAt: at }) // 断线迟到收口：孤儿 success/error 也上账
    }
    b.lastAt = now
    return buckets
  }
  return buckets
}

export function clearBucket(buckets, agentId) {
  delete buckets[agentId]
}

// ---------- 5b. 出生路径 id 自然序与族谱显式排序 ----------

/** 出生路径 id（`0` / `0-2` / `0-10`）逐段数值比较（'0-10' > '0-2'，字符串序会错）。 */
export function idOrder(a, b) {
  const pa = String(a).split('-')
  const pb = String(b).split('-')
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const va = i < pa.length ? Number(pa[i]) : -1
    const vb = i < pb.length ? Number(pb[i]) : -1
    if (va !== vb) return va - vb
  }
  return 0
}

// ---------- 5c. 二级操作菜单 / 信息面板（数据驱动，无 agent 特判） ----------

/**
 * 树行「⋯」菜单项（批 3 项 4：缩/停/毁从 header 收进本菜单）。state 全由
 * deriveActions 派生（族谱位置事实），督对根 off（面板不跑轮、无 live 流）。
 */
export function menuItems(agent) {
  if (agent === null || agent === undefined) return []
  const acts = deriveActions(agent)
  const isRoot = (agent.parentId ?? null) === null
  const items = [{ key: 'open', label: '对话', state: isRoot ? 'ready' : 'active' }]
  items.push({ key: 'watch', label: '监督', state: isRoot ? 'off' : 'ready' })
  if (!isRoot) {
    items.push({ key: 'interrupt', label: '中断', state: acts.interrupt })
    items.push({ key: 'compact', label: '压缩', state: acts.compact })
  }
  items.push({ key: 'rename', label: '改名', state: 'ready' })
  items.push({ key: 'instanceCfg', label: '实例配置', state: 'ready' })
  items.push({ key: 'classCfg', label: '类配置', state: 'ready' })
  items.push({ key: 'terminate', label: '销毁', state: acts.terminate, danger: true })
  return items
}

/** 信息卡/悬浮详情共用的字段行（全名、类、策略、token、最近活跃…）。 */
export function infoRows(agent, now = Date.now()) {
  if (agent === null || agent === undefined) return []
  const rows = [
    { k: '全名', v: `${agent.name ?? agent.id}#${agent.id}` },
    { k: '类', v: String(agent.classRef ?? '—') },
    { k: '策略', v: String(agent.strategy ?? '—') },
    { k: '状态', v: `${statusGlyph(agent.status)} ${String(agent.status ?? '')}` },
    { k: '轮数', v: String(agent.turnCount ?? 0) },
    { k: '上下文', v: `${Number(agent.ctxTokens ?? 0).toLocaleString()} tokens` },
    { k: '累计费', v: Number(agent.totalCost ?? 0).toFixed(4) },
    { k: '最近活跃', v: Number(agent.lastActive) > 0 ? relativeTime(Number(agent.lastActive), now) : '—' },
  ]
  if (agent.model) rows.push({ k: '模型', v: `${String(agent.model)}（${ORIGIN_LABELS[agent.modelOrigin] ?? String(agent.modelOrigin ?? '')}）` })
  return rows
}

const ORIGIN_LABELS = { explicit: '显式', class: '类基因', inherited: '父继承', home: '家学' }

/** 相对时刻汉字形（禁 emoji 纪律内：纯文字）。 */
export function relativeTime(ts, now = Date.now()) {
  const d = Math.max(0, now - Number(ts))
  if (Number(ts) <= 0) return '—'
  if (d < 5000) return '刚刚'
  if (d < 60000) return `${String(Math.floor(d / 1000))} 秒前`
  if (d < 3600000) return `${String(Math.floor(d / 60000))} 分前`
  if (d < 86400000) return `${String(Math.floor(d / 3600000))} 时前`
  return `${String(Math.floor(d / 86400000))} 天前`
}

/** 对话尾部统计条原料：token 合计 / 轮数 / 最近一轮耗时（末条 user → 末行）。 */
export function turnStats(messages) {
  const rows = (messages ?? []).filter((m) => m.valid !== false)
  let tokens = 0
  let maxTurn = 0
  let lastUserAt = 0
  let lastAt = 0
  let firstAt = 0
  for (const m of rows) {
    tokens += Number(m.tokens) || 0
    maxTurn = Math.max(maxTurn, Number(m.turn) || 0)
    const at = Number(m.at) || 0
    if (at > 0) {
      if (firstAt === 0) firstAt = at
      lastAt = Math.max(lastAt, at)
      if (m.role === 'user') lastUserAt = Math.max(lastUserAt, at)
    }
  }
  return { tokens, turns: maxTurn, durationS: lastUserAt > 0 && lastAt > lastUserAt ? (lastAt - lastUserAt) / 1000 : 0, firstAt, lastAt }
}

// ---------- 6. 思维链折叠视图（dsh 式：running 追最新行，结束定格首行） ----------

/**
 * 思维链文本 → 折叠呈现数据。running（还在流）：摘要 = 最新一行（跟随滚动语义）；
 * 完成：摘要 = 首行（可点开展开全文 body）。空文本 → null（不渲染）。
 */
export function reasoningView(text, running) {
  const s = String(text ?? '')
  if (s.trim() === '') return null
  const lines = s.split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return null
  return {
    summary: running ? lines[lines.length - 1] : lines[0],
    body: s,
    running: Boolean(running),
  }
}

// ---------- 7. 上下文占用（对话栏底部进度条数据层） ----------

/** 生效行 token 合计 ÷ 模型窗口上限（valid=false 的 compact 归档行不计）。 */
export function contextRatio(messages, window) {
  const cap = Number(window) > 0 ? Number(window) : 128000
  let sum = 0
  for (const m of messages ?? []) {
    if (m.valid === false) continue
    sum += Number(m.tokens) || 0
  }
  return Math.min(sum / cap, 1)
}

/** 三色带：<20% ok（绿）/ 20~40% warn（黄）/ >40% danger（红）。 */
export function ratioTone(ratio) {
  return ratio < 0.2 ? 'ok' : ratio < 0.4 ? 'warn' : 'danger'
}

// ---------- 8. 极简 markdown 渲染（零依赖；先抽码后转义再结构 = XSS 构造安全） ----------

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 行内强调/链接（输入已 HTML 转义；占位符 \u0000I<idx>\u0000 为纯字母数字不受影响）。 */
function inlineMd(s) {
  return s
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<b><i>$1</i></b>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(（])\*([^*\n]+)\*(?=$|[\s).,!?;:、」』])/, '$1<i>$2</i>') // 单星斜体首处（防乘法噪音，保守只换第一处）
    .replace(/(^|[\s(（])_([^_\n]+)_(?=$|[\s).,!?;:、」』])/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+|\/[^)\s]*)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
}

/**
 * markdown 子集 → HTML（流式容错：未闭合 ``` 视为到文末代码块）。
 * 支持：围栏代码块 / 行内码 / 标题 / 引用 / 无序·有序列表 / 表格（含分隔行）/
 * hr / 粗斜体 / 链接 / 段落（单换行 <br/>）。
 */
export function mdToHtml(raw) {
  const src = String(raw ?? '')
  if (src.trim() === '') return ''
  // 1) 抽围栏代码块与行内码为占位符（内容不进转义流水线，还原时各自 escape）。
  const fences = []
  const texts = []
  let text = src
    .replace(/```([\s\S]*?)(?:```|$)/g, (_m, code) => {
      fences.push(code.replace(/^[^\n]*\n/, '').replace(/\n$/, '')) // 首行语言标忽略
      return `\u0000B${fences.length - 1}\u0000`
    })
    .replace(/`([^`\n]+)`/g, (_m, c) => {
      texts.push(c)
      return `\u0000I${texts.length - 1}\u0000`
    })
  const lines = escapeHtml(text).split('\n')
  const out = []
  let para = []
  let list = null
  const flushPara = () => {
    if (para.length > 0) {
      out.push('<p>' + para.map(inlineMd).join('<br/>') + '</p>')
      para = []
    }
  }
  const flushList = () => {
    if (list !== null) {
      out.push(`</${list}>`)
      list = null
    }
  }
  const fenceOnly = (line) => /^\u0000B(\d+)\u0000$/.exec(line.trim())
  const restoreFence = (m, i) => `<pre><code>${escapeHtml(fences[Number(i)])}</code></pre>`
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    const f = fenceOnly(line)
    if (f !== null) {
      flushPara()
      flushList()
      out.push(restoreFence('', f[1]))
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h !== null) {
      flushPara()
      flushList()
      out.push(`<h${String(h[1].length)}>${inlineMd(h[2])}</h${String(h[1].length)}>`)
      continue
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      flushPara()
      flushList()
      out.push('<hr/>')
      continue
    }
    const q = /^&gt;\s?(.*)$/.exec(line)
    if (q !== null) {
      flushPara()
      flushList()
      out.push(`<blockquote>${inlineMd(q[1])}</blockquote>`)
      continue
    }
    // 表格：| 开头行 + 下一行为分隔行（---|---）触发。
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[li + 1] ?? '')) {
      flushPara()
      flushList()
      const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => inlineMd(c.trim()))
      const rows = [cells(line)]
      li += 1
      while (li + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[li + 1])) rows.push(cells(lines[++li]))
      out.push(
        '<table><thead><tr>' + rows[0].map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>' +
          rows.slice(1).map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') +
          '</tbody></table>',
      )
      continue
    }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line)
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ul !== null || ol !== null) {
      flushPara()
      const want = ul !== null ? 'ul' : 'ol'
      if (list !== want) {
        flushList()
        out.push(`<${want}>`)
        list = want
      }
      out.push(`<li>${inlineMd(ul !== null ? ul[1] : ol[1])}</li>`)
      continue
    }
    if (line.trim() === '') {
      flushPara()
      flushList()
      continue
    }
    para.push(line)
  }
  flushPara()
  flushList()
  let html = out.join('\n')
  html = html.replace(/\u0000B(\d+)\u0000/g, restoreFence) // 行内漏网的围栏占位（如围栏后同行文字）降级为代码块
  html = html.replace(/\u0000I(\d+)\u0000/g, (_m, i) => `<code>${escapeHtml(texts[Number(i)])}</code>`)
  return html
}
