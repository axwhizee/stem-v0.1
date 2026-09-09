// ============================================================
// shell/webui/app.js —— WebUIShell 浏览器应用脚本（三件套之分文件）
//
// 结构（批 3 布局）：左栏 = 标题（隠/設）+ 族谱树（状态字前置 + 浮动「選」
// 菜单）+ 实例化面板 + 快捷设置（模型环/思考程度占位）；主区 = 无边框文档流
// timeline + composer（输入框在上、信息条行在下：附钮左 · 六项元信息中 ·
// 状态+连接右 · 送钮右）+ 铺底占用条。header 已废除——agent 事实进信息条，
// 动作进二级菜单与设置面板（模态，实例/类双页签）。
// 流式 live 层纪律：delta live-only（applyStreamEvent 分桶），轮末 letter →
// loadContext 快照收口不补间隙；思维链折叠 running 追最新行、结束定格首行
// （summary 与 rest 零重复）；rAF 合帧节流。全部纯逻辑住 view.js（可测）。
// ============================================================

import { ACT_GLYPH, ROOT_ID, applyStreamEvent, clearBucket, composerMeta, computeTreeRows, contextRatio, createLiveBuckets, deriveActions, infoRows, mdToHtml, menuItems, ratioTone, reasoningView, relativeTime, routeLetters, statusGlyph, statusTone, truncate, turnStats } from './view.js'

const $ = (id) => document.getElementById(id)
const timeline = $('timeline')
let currentAgentId = ''
let agentsCache = []
let templatesCache = []
let pendingAccess = null
// —— 流式 live 层状态 ——
const liveBuckets = createLiveBuckets()
let watchAgentId = '' // 监督抽屉目标（'' = 关）
let liveHost = null
let ctxWindow = 128000
let ctxRatio = 0
let paintQueued = false

// ---------- 族谱侧栏 ----------

function lanesSvg(row) {
  const L = 14, half = 12
  const parts = []
  const color = row.type === 'node' ? (row.family === 0 ? 'var(--accent)' : row.family === 1 ? 'var(--muted)' : 'var(--border-strong)') : 'var(--border-strong)'
  for (const lane of row.passThrough ?? []) {
    parts.push(`<line x1="${(lane + 0.5) * L}" y1="0" x2="${(lane + 0.5) * L}" y2="24" stroke="${color}" stroke-width="1" opacity=".55"/>`)
  }
  if (row.type === 'node') {
    const cx = (row.lane + 0.5) * L
    if (row.join && row.parentLane !== null) {
      const px = (row.parentLane + 0.5) * L
      if (px === cx) parts.push(`<line x1="${px}" y1="0" x2="${cx}" y2="${half}" stroke="${color}" stroke-width="1"/>`)
      else parts.push(`<path d="M ${px} 0 L ${px} ${half} L ${cx} ${half}" fill="none" stroke="${color}" stroke-width="1"/>`)
    }
    parts.push(`<circle cx="${cx}" cy="${half}" r="3" fill="${row.isRoot ? 'none' : color}" stroke="${color}" stroke-width="1.5"/>`)
  } else {
    parts.push(`<text x="${(row.lane + 0.5) * L - 3}" y="15" fill="var(--muted)" font-size="11">└</text>`)
  }
  return `<svg class="lanes" viewBox="0 0 ${5 * L} 24" aria-hidden="true">${parts.join('')}</svg>`
}

async function loadAgents() {
  const agents = await fetch('/api/agents').then((r) => r.json())
  agentsCache = agents
  const tree = $('tree')
  tree.innerHTML = ''
  for (const row of computeTreeRows(agents)) {
    const el = document.createElement('div')
    if (row.type === 'more') {
      el.className = 'tnode moren'
      const label = row.kind === 'siblings' ? `… +${row.count} 兄弟（共 ${row.descendants} 实例）` : `… +${row.count} 后代（更深层折叠）`
      el.innerHTML = lanesSvg(row) + `<span>${label}</span>`
      tree.appendChild(el)
      continue
    }
    const a = row.row
    el.className = 'tnode' + (a.id === currentAgentId ? ' active' : '') + (row.isRoot ? ' rootnode' : '')
    const tone = statusTone(a.status)
    const glyph = row.isRoot ? ACT_GLYPH.me : statusGlyph(a.status)
    const lp = a.lastPrompt ? truncate(a.lastPrompt, 24) : `<${a.classRef ?? ''}>`
    // 状态字前置；「選」钮 CSS 绝对浮动（平时零占位不挤行）
    el.innerHTML = lanesSvg(row) + `<span class="st tone-${tone}">${glyph}</span><span class="id">${esc(String(a.name ?? a.id))}</span><span class="lp">${esc(decodeEntities(lp))}</span>` +
      (row.isRoot ? '' : `<span class="mbtn" title="操作菜单">選</span>`)
    el.onclick = () => selectAgent(a.id)
    el.oncontextmenu = (e) => { e.preventDefault(); openMenu(a, e.clientX, e.clientY) }
    const mb = el.querySelector('.mbtn')
    if (mb !== null) mb.addEventListener('click', (e) => { e.stopPropagation(); const r = mb.getBoundingClientRect(); openMenu(a, r.left - 120, r.bottom + 2) })
    bindHover(el, a.id)
    tree.appendChild(el)
  }
  renderComposerMeta()
  renderQuickBox()
}

const decodeEntities = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const currentAgent = () => agentsCache.find((x) => x.id === currentAgentId) ?? null

// —— composer 信息条（header 废除后 agent 事实的家）：六项元信息 + 右端状态/连接 ——
function renderComposerMeta() {
  const a = currentAgent()
  $('cMeta').innerHTML = a === null ? '<span class="item"><span class="k">族谱全景 · 选择一位后代开始对话</span></span>'
    : composerMeta(a).map((r, i) => `<span class="item${i === 0 ? ' head' : ''}" title="${esc(r.k)}"><span class="k">${esc(r.k)}</span><span class="v">${esc(r.v)}</span></span>`).join('')
  const cr = $('cRight')
  if (a === null) { cr.textContent = ''; cr.className = '' }
  else {
    cr.innerHTML = `<span id="agentSt">${esc(statusGlyph(a.status))} ${esc(String(a.status ?? ''))}</span><span id="conn" class="${$('conn').classList.contains('on') ? 'on' : ''}" title="事件流连接"></span>`
    cr.className = 'tone-' + statusTone(a.status)
  }
}

// —— 左栏底：快捷设置（当前 agent 的模型环 + 思考程度占位） ——
function renderQuickBox() {
  const a = currentAgent()
  $('quickBox').hidden = a === null
  if (a === null) return
  $('quickName').textContent = `${String(a.name ?? a.id)}#${a.id}`
  renderModelRow(a)
}

const ORIGIN_LABEL = { explicit: '显式', class: '类基因', inherited: '父继承', home: '家学' }
let modelRefs = []

async function loadModels() {
  const data = await fetch('/api/models').then((r) => r.json())
  modelRefs = data.refs ?? []
  const cm = $('createModel')
  cm.innerHTML = ''
  cm.add(new Option('模型：继承链（类基因>父继承>家学）', ''))
  for (const ref of modelRefs) cm.add(new Option('出生显式 · ' + ref, ref))
}

function renderModelRow(agent) {
  const sel = $('modelSel')
  sel.innerHTML = ''
  if (!agent || !agent.model) { sel.disabled = true; $('modelOrigin').textContent = '继承链'; return }
  sel.disabled = false
  const cur = agent.model
  const refs = modelRefs.includes(cur) ? modelRefs : [cur, ...modelRefs]
  for (const ref of refs) sel.appendChild(new Option(ref, ref))
  sel.value = cur
  $('modelOrigin').textContent = ORIGIN_LABEL[agent.modelOrigin] ?? agent.modelOrigin ?? ''
}

$('modelSel').onchange = async () => {
  if (!currentAgentId) return
  await fetch('/api/set_model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: currentAgentId, model: $('modelSel').value }) })
  await loadAgents()
}

// —— 悬浮详情卡（infoRows 与数据源同源） ——
let hoverTimer = 0
let hideTimer = 0
function bindHover(el, id) {
  el.addEventListener('mouseenter', () => {
    clearTimeout(hideTimer)
    hoverTimer = setTimeout(() => {
      const a = agentsCache.find((x) => x.id === id)
      if (a === undefined) return
      const r = el.getBoundingClientRect()
      const card = $('hoverCard')
      card.innerHTML = `<div class="t">${esc(String(a.name ?? a.id))}#${esc(a.id)}</div><div class="r">` +
        infoRows(a).map((row) => `<span>${esc(row.k)}</span><b>${esc(row.v)}</b>`).join('') +
        `</div><div class="r" style="margin-top:3px"><span>最近对话</span><b>${esc(a.lastPrompt ? truncate(a.lastPrompt, 28) : '—')}</b></div>`
      card.hidden = false
      card.style.left = Math.min(r.right + 6, innerWidth - 268) + 'px'
      card.style.top = Math.min(r.top, innerHeight - card.offsetHeight - 8) + 'px'
    }, 400)
  })
  el.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimer)
    hideTimer = setTimeout(() => { $('hoverCard').hidden = true }, 150)
  })
  el.addEventListener('mousedown', () => clearTimeout(hoverTimer))
}

// —— 二级操作菜单（树行「選」/右击；对话/监督/中断/压缩/改名/配置/销毁） ——
function openMenu(agent, x, y) {
  const m = $('popover')
  m.innerHTML = ''
  for (const it of menuItems(agent)) {
    const b = document.createElement('button')
    b.textContent = it.label
    b.dataset.state = it.state
    if (it.danger === true) b.className = 'danger'
    if (it.state !== 'off') b.onclick = () => { closeMenu(); void runMenuAction(it.key, agent) }
    m.appendChild(b)
  }
  m.hidden = false
  m.style.left = Math.min(x, innerWidth - m.offsetWidth - 8) + 'px'
  m.style.top = Math.min(y, innerHeight - m.offsetHeight - 8) + 'px'
}
function closeMenu() { $('popover').hidden = true }
document.addEventListener('click', (e) => { const m = $('popover'); if (!m.hidden && !m.contains(e.target)) closeMenu() })

async function runMenuAction(key, agent) {
  switch (key) {
    case 'open': await selectAgent(agent.id); break
    case 'watch': (watchAgentId === agent.id ? closeDrawer : openDrawer)(agent.id); break
    case 'interrupt': await fetch('/api/interrupt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: agent.id }) }); break
    case 'compact':
      await fetch('/api/context_action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: agent.id, action: 'compact' }) })
      if (agent.id === currentAgentId) await loadContext(agent.id)
      break
    case 'rename': await selectAgent(agent.id); openSettings(agent, 'instance'); $('renameInput').focus(); break
    case 'instanceCfg': openSettings(agent, 'instance'); break
    case 'classCfg': openSettings(agent, 'class'); break
    case 'terminate': await terminateAgent(agent); break
  }
}

// —— 设置面板（模态双页签；左栏不再挤占空间） ——
let settingsAgent = null
function openSettings(agent, tab = 'instance') {
  settingsAgent = agent
  $('settingsMask').hidden = false
  $('stAgent').textContent = `${String(agent.name ?? agent.id)}#${agent.id}`
  $('renameInput').placeholder = `当前「${String(agent.name ?? agent.id)}」→ 新称呼`
  renderClassDef(agent)
  switchCfgTab(tab)
}
function closeSettings() { settingsAgent = null; $('settingsMask').hidden = true }
$('stClose').onclick = closeSettings
$('settingsMask').addEventListener('click', (e) => { if (e.target === $('settingsMask')) closeSettings() })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSettings(); closeMenu() } })
$('settingsBtn').onclick = () => openSettings(currentAgent() ?? agentsCache.find((x) => x.id === ROOT_ID) ?? { id: ROOT_ID, name: 'user' })

function renderClassDef(agent) {
  const t = templatesCache.find((x) => x.name === agent.classRef)
  const el = $('classDef')
  if (t === undefined) { el.textContent = `（类 ${String(agent.classRef ?? '—')} 定义不在本次装载清单）`; return }
  const tools = t.tools === undefined ? '（完整继承父档案）' : Object.entries(t.tools).map(([k, v]) => `${k}=${v}`).join(' ') || '（空表 = 本地封闭）'
  el.textContent =
`类 ${t.name}
描述：${t.description ?? '—'}
策略：${t.contextStrategy ?? '继承'}
工具：${tools}
提示词：${(t.systemPrompt ?? '—').slice(0, 400)}${(t.systemPrompt ?? '').length > 400 ? '…' : ''}`
}

function switchCfgTab(tab) {
  for (const b of $('stTabs').querySelectorAll('button')) b.classList.toggle('on', b.dataset.tab === tab)
  $('stInstance').hidden = tab !== 'instance'
  $('stClass').hidden = tab !== 'class'
}
for (const b of $('stTabs').querySelectorAll('button')) b.onclick = () => switchCfgTab(b.dataset.tab)

$('renameBtn').onclick = async () => {
  const name = $('renameInput').value.trim()
  if (name === '' || settingsAgent === null) return
  const r = await fetch('/api/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: settingsAgent.id, name }) }).then((x) => x.json())
  if (r.error !== undefined) { alert(String(r.error)); return }
  $('renameInput').value = ''
  await loadAgents()
}

// ---------- 第一视角时间线 ----------

function renderTimeline(items) {
  timeline.innerHTML = ''
  liveHost = null // 历史整建：live 尾层随 next paint 重建
  for (const it of items) {
    if (it.kind === 'ask') continue // 来信 access_request → 「审」面板，不占正文流
    if (it.kind === 'meta') { timeline.appendChild(msgEl('meta', it.icon + '  ' + it.text)); continue }
    if (it.kind === 'tool') { timeline.appendChild(msgEl('tool', it.icon + '  ' + it.text)); continue }
    timeline.appendChild(msgEl(it.side, it.text, it.who))
  }
  if (items.length === 0) timeline.appendChild(emptyHint())
  timeline.scrollTop = timeline.scrollHeight
}

function emptyHint() {
  const el = document.createElement('div')
  el.id = 'empty'
  if (agentsCache.filter((a) => a.parentId !== null).length === 0) {
    el.innerHTML = '族谱仅根 <b>user#0</b>。<br/>于左下「<b>生</b>」实例化第一位后代，它将成为你的子节点、开启协作。'
  } else {
    el.innerHTML = '从左侧<b>族谱树</b>选择一位后代开始对话。'
  }
  return el
}

function msgEl(cls, text, who) {
  const el = document.createElement('div')
  el.className = 'msg ' + cls
  if (who) el.innerHTML = `<div class="who">${esc(who)}</div>`
  if (cls === 'tool' || cls === 'meta') {
    el.appendChild(document.createTextNode(text)) // 非 markdown 通道保原样
  } else {
    const d = document.createElement('div')
    d.className = 'md'
    d.innerHTML = mdToHtml(text)
    el.appendChild(d)
    const cp = document.createElement('button') // hover 复制原文
    cp.className = 'copyBtn'; cp.textContent = '複'; cp.title = '复制原文'
    cp.onclick = () => { void navigator.clipboard?.writeText(text) }
    el.appendChild(cp)
  }
  return el
}

async function loadContext(id) {
  if (id !== currentAgentId) return // 快速连点防御：迟到响应不覆盖新选窗口
  const data = await fetch('/api/agents/' + encodeURIComponent(id) + '/context').then((r) => r.json())
  if (id !== currentAgentId) return
  ctxWindow = Number(data.contextWindow) > 0 ? Number(data.contextWindow) : 128000
  renderTimeline(routeLetters(data.messages || [], id))
  ctxRatio = contextRatio(data.messages, ctxWindow)
  paintCtxBar(ctxRatio)
  const st = turnStats(data.messages)
  const ts = $('turnStats')
  ts.hidden = !(st.durationS > 0)
  ts.textContent = st.durationS > 0 ? `最近一轮耗时 ${st.durationS.toFixed(1)}s` : '' // 轮数/token 已在信息条
  schedulePaint()
}

// ---------- 上下文占用进度条（composer 之下铺底，三色带） ----------

function paintCtxBar(ratio) {
  const fill = $('ctxFill')
  fill.style.width = Math.round(ratio * 100) + '%'
  fill.className = ratioTone(ratio)
  $('ctxBar').title = `上下文占用 ${(ratio * 100).toFixed(1)}% / ${ctxWindow.toLocaleString()} tokens`
}

// ---------- 流式 live 层渲染（rAF 合帧节流；主列尾与抽屉共用 builder） ----------

function liveDom(bucket, id) {
  const frag = document.createDocumentFragment()
  const rv = reasoningView(bucket.reasoning, bucket.text === '') // 正文未起 = 还在想
  if (rv !== null) {
    const d = document.createElement('details')
    d.className = 'reason' + (bucket.text === '' ? ' running' : '')
    const s = document.createElement('summary')
    s.textContent = rv.summary
    d.appendChild(s)
    if (rv.rest !== '') { // 展开 = 去掉摘要行的正文：与折叠头零重复
      const b = document.createElement('div')
      b.className = 'rbody'
      b.innerHTML = mdToHtml(rv.rest)
      d.appendChild(b)
    }
    frag.appendChild(d)
  }
  for (const t of bucket.tools) {
    const chip = document.createElement('div')
    const dur = t.doneAt > 0 && t.doneAt >= t.at ? ' · ' + ((t.doneAt - t.at) / 1000).toFixed(1) + 's' : ''
    chip.className = 'chip ' + t.phase
    chip.textContent = `${ACT_GLYPH.tool} ${t.name} ${t.phase === 'called' ? '执行' : t.phase === 'success' ? '完成' : '失败'}${dur}`
    frag.appendChild(chip)
  }
  if (bucket.text !== '') {
    const b = document.createElement('div')
    b.className = 'msg agent streaming'
    const who = document.createElement('div'); who.className = 'who'; who.textContent = bucketLabel(id)
    b.appendChild(who)
    const d = document.createElement('div')
    d.className = 'md'
    d.innerHTML = mdToHtml(bucket.text)
    b.appendChild(d)
    frag.appendChild(b)
  }
  return frag
}

const bucketLabel = (id) => { const a = agentsCache.find((x) => x.id === id); return a !== undefined && a.name !== undefined ? a.name : id }

function nearBottom() { return timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 160 }

function renderLive() {
  const b = currentAgentId !== '' ? liveBuckets[currentAgentId] : undefined
  if (b !== undefined) {
    if (liveHost === null || !liveHost.isConnected) {
      liveHost = document.createElement('div')
      liveHost.id = 'liveHost'
      timeline.appendChild(liveHost)
    }
    const stick = nearBottom()
    liveHost.replaceChildren(liveDom(b, currentAgentId))
    if (stick) timeline.scrollTop = timeline.scrollHeight
  } else if (liveHost !== null) {
    liveHost.remove()
    liveHost = null
  }
  if (watchAgentId !== '') {
    const wb = liveBuckets[watchAgentId]
    if (wb !== undefined) {
      const body = $('drawerBody')
      const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 160
      body.replaceChildren(liveDom(wb, watchAgentId))
      if (stick) body.scrollTop = body.scrollHeight
    }
  }
}

function schedulePaint() {
  if (paintQueued) return
  paintQueued = true
  requestAnimationFrame(() => { paintQueued = false; renderLive() })
}

// ---------- 监督抽屉 ----------

function openDrawer(id) {
  watchAgentId = id
  $('drawer').hidden = false
  $('drawerTitle').textContent = '督 · ' + bucketLabel(id)
  schedulePaint()
}
function closeDrawer() {
  if (watchAgentId !== '') clearBucket(liveBuckets, watchAgentId)
  watchAgentId = ''
  $('drawer').hidden = true
  $('drawerBody').innerHTML = ''
}
$('drawerClose').onclick = closeDrawer

// ---------- 访问确认（ask → 审面板，顶部居中） ----------

function showPermission(content) {
  const m = content.match(/<access_request id="([^"]+)" accessKey="([^"]+)" agentId="([^"]+)">/)
  if (m === null) return
  pendingAccess = { requestId: m[1], accessKey: m[2], agentId: m[3] }
  $('permBody').textContent = `agent ${m[3]} 申请使用工具「${m[2]}」（授权者：族谱根 user#0 = 你）`
  $('permission').style.display = 'block'
}
async function replyAccess(reply) {
  if (pendingAccess === null) return
  await fetch('/api/access', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: pendingAccess.requestId, reply }) })
  pendingAccess = null
  $('permission').style.display = 'none'
}
$('permOnce').onclick = () => replyAccess('once')
$('permAlways').onclick = () => replyAccess('always')
$('permReject').onclick = () => replyAccess('reject')

// ---------- 事件流（delta + tool 相进桶；letter 快照收口；status 清画布） ----------

function openStream() {
  const es = new EventSource('/api/events')
  es.onopen = () => { $('conn')?.classList.add('on') }
  es.onmessage = (e) => handleEvent(JSON.parse(e.data))
  es.onerror = () => { $('conn')?.classList.remove('on'); es.close(); setTimeout(openStream, 2000) }
}

function handleEvent(ev) {
  applyStreamEvent(liveBuckets, ev)
  if (ev.type === 'stream' || ev.type === 'tool') {
    if (ev.agentId === currentAgentId || ev.agentId === watchAgentId) schedulePaint()
    return
  }
  if (ev.type === 'letter') {
    const content = (ev.letters && ev.letters[0] && typeof ev.letters[0].content === 'string') ? ev.letters[0].content : ''
    if (content.startsWith('<access_request')) { showPermission(content); return }
    if (ev.agentId === currentAgentId) {
      void loadContext(currentAgentId).then(() => clearBucket(liveBuckets, currentAgentId))
      void loadAgents() // 信息条六项随轮末账目刷新（ctxTokens/轮次/累计 token）
    }
    return
  }
  if (ev.type === 'status') {
    void loadAgents()
    if (ev.to === 'thinking') clearBucket(liveBuckets, ev.agentId) // 新轮开画布
    if ((ev.to === 'holding' || ev.to === 'idle') && (ev.agentId === currentAgentId || ev.agentId === watchAgentId)) schedulePaint()
  }
}

// ---------- 会话动作 ----------

function applyActions(agent) {
  const s = deriveActions(agent)
  const canSend = s.send !== 'off'
  $('sendBtn').disabled = !canSend
  $('input').disabled = !canSend
  $('input').placeholder = canSend ? `向 ${agent?.name ?? agent?.id ?? ''} 发消息（Enter 发送，Shift+Enter 换行）` : '选择一位后代开始对话…'
}

async function selectAgent(id) {
  currentAgentId = id
  const agents = await fetch('/api/agents').then((r) => r.json())
  agentsCache = agents
  const a = agents.find((x) => x.id === id) ?? null
  applyActions(a)
  renderComposerMeta()
  renderQuickBox()
  await loadAgents()
  if (a !== null && a.parentId === null) {
    const data = await fetch('/api/agents/' + encodeURIComponent(id) + '/context').then((r) => r.json())
    renderTimeline(routeLetters(data.messages || [], id))
    ctxRatio = contextRatio(data.messages, data.contextWindow)
    paintCtxBar(ctxRatio)
    $('turnStats').hidden = true
  } else {
    await loadContext(id)
  }
}

async function terminateAgent(agent) {
  const id = agent.id
  if (!confirm(`销毁 ${id}？（级联销毁其子树；消息语料保留于仓库）`)) return
  await fetch('/api/terminate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: id, recursive: true }) })
  if (id === currentAgentId) {
    currentAgentId = ''
    $('turnStats').hidden = true
    applyActions(null)
    timeline.innerHTML = ''; timeline.appendChild(emptyHint())
  }
  if (id === watchAgentId) closeDrawer()
  if (settingsAgent !== null && settingsAgent.id === id) closeSettings()
  await loadAgents()
}

// ---------- 侧栏收起 / 展开 ----------
$('sideToggle').onclick = () => {
  const mini = document.body.classList.toggle('side-mini')
  $('sideToggle').textContent = mini ? '展' : '隠'
  $('sideToggle').title = mini ? '展开侧栏' : '收起侧栏（简化族谱）'
}

// ---------- 对话与实例化 ----------

async function send() {
  const text = $('input').value.trim()
  if (text === '' || !currentAgentId) return
  $('input').value = ''
  await fetch('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: currentAgentId, text }) })
}

async function createAgent() {
  const className = $('createClass').value
  const userPrompt = $('createPrompt').value.trim() || '你好，请做一个简短的自我介绍。'
  const body = { className, userPrompt }
  const model = $('createModel').value // 空 = 不显式（落类基因>父继承>家学链）
  if (model) body.model = model
  const r = await fetch('/api/instantiate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await r.json()
  if (data.agentId) { $('createPrompt').value = ''; void selectAgent(data.agentId) }
}

async function loadTemplates() {
  const templates = await fetch('/api/templates').then((r) => r.json())
  templatesCache = templates
  const sel = $('createClass')
  sel.innerHTML = ''
  for (const t of templates) {
    if (t.panel) continue // 面板类（user/策略 role）不可实例化对话
    sel.appendChild(new Option(t.name, t.name))
  }
}

$('sendBtn').onclick = send
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } })
$('createBtn').onclick = createAgent

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) }

// ---------- 启动（空桌引导） ----------
;(async () => {
  await loadModels()
  await loadTemplates()
  await loadAgents()
  renderTimeline([])
  applyActions(null)
  openStream()
})()
