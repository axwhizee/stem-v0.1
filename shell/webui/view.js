// ============================================================
// shell/webui/view.js —— WebUI 视图纯函数核心（S6 批 2，R8/R9）
//
// 零 DOM（浏览器经 <script type="module"> import；node:test 直测）。
// 承载四组纯逻辑：
//   1. 汉字字形表（R8：禁 emoji/几何字符，状态/动作全汉字）+ 三态语义；
//   2. 信箱归位 routeLetters（R9 第一视角：user0 非对话窗口，来信按
//      <sender> 反查归位各 agent 窗）；
//   3. git 风族谱行序 computeTreeRows（DFS + 泳道 + 溢出折叠）；
//   4. 按钮可用性 deriveActions（能力数据驱动，非 agent 特判——
//      根不可销毁等事实全部来自族谱位置，seed #5 就此消除）。
// ============================================================

/** 本空间根（pilot 扮演身份的约定 id）。 */
export const ROOT_ID = 'user0'

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

/** 剥发送者戳：`<sender id="x">…</sender>` → {sender, text}。 */
export function stripSender(raw) {
  const m = /^<sender id="([^"]+)">([\s\S]*?)<\/sender>$/.exec(String(raw ?? ''))
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
 * - 根（user0）窗：反相——assistant = 人类发言（右"我"），user = 后代回信（左）；
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
        const mine = sender === '' || sender === rootId
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
  // 约定根恒先行（其余无父行为防御性并列根）。
  roots.sort((a, b) => (a.id === rootId ? -1 : b.id === rootId ? 1 : 0))
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
      const children = byParent.get(node.id) ?? []
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
