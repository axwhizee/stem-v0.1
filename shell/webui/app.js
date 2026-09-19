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

import { ACT_GLYPH, ROOT_ID, applyStreamEvent, clearBucket, composerMeta, computeTreeRows, contextRatio, createLiveBuckets, deriveActions, infoRows, mdToHtml, menuItems, ratioTone, reasoningView, relativeTime, routeLetters, statusGlyph, statusTone, toolFold, truncate, turnStats } from './view.js'

const $ = (id) => document.getElementById(id)
const timeline = $('timeline')
let currentAgentId = ''
let agentsCache = []
let templatesCache = []

// —— 流式 live 层状态 ——
const liveBuckets = createLiveBuckets()
let watchAgentId = '' // 监督抽屉目标（'' = 关）
let liveHost = null
let ctxWindow = 1000000
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

async function loadAgents(prefetched) {
  const agents = prefetched ?? await fetch('/api/agents').then((r) => r.json())
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
// 呈现面统一 name#id：routeLetters 的发送者标签由它把裸 id 转全名（B4）。
const nameOf = (id) => { const a = agentsCache.find((x) => x.id === id); return a !== undefined && a.name !== undefined ? a.name : undefined }

// —— composer 信息条（header 废除后 agent 事实的家）：六项元信息 + 右端状态/连接 ——
function renderComposerMeta() {
  const a = currentAgent()
  $('cMeta').innerHTML = a === null ? '<span class="item"><span class="k">族谱全景 · 选择一位后代开始对话</span></span>'
    : composerMeta(a).map((r, i) => `<span class="item${i === 0 ? ' head' : ''}" title="${esc(r.k)}"><span class="k">${esc(r.k)}</span><span class="v">${esc(r.v)}</span></span>`).join('')
  const cr = $('cRight')
  // 注意：重建 cRight 会销毁静态 #conn——读写一律 null-safe（?.），且把连接态
  // 随重建传递（旧版在此 throw TypeError 截断 selectAgent 后续渲染，事故修复）。
  const connOn = $('conn')?.classList.contains('on') === true
  if (a === null) { cr.innerHTML = `<span id="conn" class="${connOn ? 'on' : ''}" title="事件流连接"></span>`; cr.className = '' }
  else {
    cr.innerHTML = `<span id="agentSt">${esc(statusGlyph(a.status))} ${esc(String(a.status ?? ''))}</span><span id="conn" class="${connOn ? 'on' : ''}" title="事件流连接"></span>`
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
  const cur = agent === null || agent === undefined ? '' : String(agent.model ?? '')
  const origin = agent !== null && agent !== undefined ? ORIGIN_LABEL[agent.modelOrigin] ?? agent.modelOrigin ?? '' : ''
  for (const [sel, badge, inheritLabel] of [[$('modelSel'), $('modelOrigin'), '继承链'], [$('stModel'), $('stModelOrigin'), '继承链']]) {
    sel.innerHTML = ''
    if (cur === '') {
      sel.disabled = true
      sel.appendChild(new Option('（走继承链）', ''))
      badge.textContent = inheritLabel
      continue
    }
    sel.disabled = false
    const refs = modelRefs.includes(cur) ? modelRefs : [cur, ...modelRefs]
    for (const ref of refs) sel.appendChild(new Option(ref, ref))
    sel.value = cur
    badge.textContent = String(origin)
  }
}

async function setModel(ref) {
  if (!currentAgentId || ref === '') return
  await fetch('/api/set_model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: currentAgentId, model: ref }) })
  await loadAgents()
}
$('modelSel').onchange = () => void setModel($('modelSel').value)
$('stModel').onchange = () => void setModel($('stModel').value)

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

// —— 设置面板（模态双页签：实例参数 + 类定义进化面） ——
let settingsAgent = null
function openSettings(agent, tab = 'instance') {
  settingsAgent = agent
  $('settingsMask').hidden = false
  $('stAgent').textContent = `${String(agent.name ?? agent.id)}#${agent.id}`
  $('renameInput').placeholder = `当前「${String(agent.name ?? agent.id)}」→ 新称呼`
  $('renameInput').value = ''
  $('classHint').textContent = ''
  renderModelRow(currentAgent() ?? agent)
  fillClassForm(agent.classRef ?? '')
  switchCfgTab(tab)
}
function closeSettings() { settingsAgent = null; $('settingsMask').hidden = true }
$('stClose').onclick = closeSettings
$('settingsMask').addEventListener('click', (e) => { if (e.target === $('settingsMask')) closeSettings() })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSettings(); closeMenu() } })
$('settingsBtn').onclick = () => openSettings(currentAgent() ?? agentsCache.find((x) => x.id === ROOT_ID) ?? { id: ROOT_ID, name: 'user' })

// 类页签：下拉 = 装载类全集（panel 只读）；字段回填自 templatesCache 现值。
function fillClassForm(classRef) {
  const sel = $('stClassSel')
  sel.innerHTML = ''
  for (const t of templatesCache) sel.appendChild(new Option(t.panel ? `${t.name}（面板·只读）` : t.name, t.name))
  if (templatesCache.some((t) => t.name === classRef)) sel.value = String(classRef)
  prefillClass()
}
function prefillClass() {
  const t = templatesCache.find((x) => x.name === $('stClassSel').value)
  const locked = t === undefined || t.panel === true
  $('stClassDesc').value = t?.description ?? ''
  $('stClassPrompt').value = t?.systemPrompt ?? ''
  $('stClassStrategy').value = t?.contextStrategy ?? ''
  $('stClassTools').textContent = t === undefined ? '' : t.tools === undefined ? '工具：继承父档案' : `工具：${Object.entries(t.tools).map(([k, v]) => `${k}=${v}`).join(' ') || '本地封闭'}`
  for (const el of [$('stClassDesc'), $('stClassPrompt'), $('stClassStrategy'), $('classSaveBtn')]) el.disabled = locked
  $('classHint').textContent = t !== undefined && t.panel ? '面板类不可编辑（user/策略 role 红线）' : ''
}
$('stClassSel').onchange = prefillClass
$('classSaveBtn').onclick = async () => {
  const name = $('stClassSel').value
  if (name === '') return
  const r = await fetch('/api/class_update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description: $('stClassDesc').value, systemPrompt: $('stClassPrompt').value, contextStrategy: $('stClassStrategy').value }),
  }).then((x) => x.json())
  if (r.error !== undefined) { $('classHint').textContent = String(r.error); return }
  $('classHint').textContent = r.persisted ? '已合并落盘（只影响后续实例）' : '已合并（内存，无落盘通道）'
  await loadTemplates()
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
    if (it.kind === 'meta') { timeline.appendChild(msgEl('meta', it.icon + '  ' + it.text)); continue }
    if (it.kind === 'tool') { timeline.appendChild(toolLineEl(it.text, it.who, it.toolName)); continue } // 工具结果 = 默认折叠件
    timeline.appendChild(msgEl(it.side, it.text, it.who))
  }
  if (items.length === 0) timeline.appendChild(emptyHint())
  timeline.scrollTop = timeline.scrollHeight
}

/** 工具结果行折叠件：默认收起一行头 = **工具名**（首行）+ 来源 + 规模；展开看全文。 */
function toolLineEl(text, who, toolName) {
  const el = document.createElement('div')
  const tf = toolFold(text)
  el.className = 'toolmsg shut'
  el.title = '点击展开/收起工具输出'
  const head = document.createElement('div')
  head.className = 'thead'
  // 首行格式：`工`（主色图标）+ 工具名（普通色，关联还原；无则回退结果首行）
  // + 末尾字数/行数统计。**不显示调用者**——工具行显然属于当前窗 agent，省略噪音。
  const nameText = toolName ?? (tf === null ? '' : tf.head)
  const meta = tf === null ? '' : tf.meta
  head.innerHTML = `<b class="ticon">${ACT_GLYPH.tool}</b><span class="tname">${esc(nameText)}</span> <span class="tcnt">${esc(meta)}</span>`
  const body = document.createElement('div')
  body.className = 'tbody'
  body.textContent = tf === null ? text : tf.full
  el.appendChild(head)
  el.appendChild(body)
  el.onclick = () => el.classList.toggle('shut')
  return el
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
  ctxWindow = Number(data.contextWindow) > 0 ? Number(data.contextWindow) : 1000000
  renderTimeline(routeLetters(data.messages || [], id, ROOT_ID, nameOf))
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
  const running = bucket.text === '' // 正文未起 = 还在想
  const rv = reasoningView(bucket.reasoning, running)
  if (rv !== null) {
    // 自定义折叠件（弃 native details）：**默认展开流全文**、点击任意处收起/
    // 展开、收起态只留头行——两态零重复；shut 态记在 bucket 上跨帧存活。
    const d = document.createElement('div')
    const shut = bucket.rShut === true
    d.className = 'reason' + (shut ? ' shut' : '') + (running ? ' running' : '')
    const head = document.createElement('div')
    head.className = 'rsum'
    head.textContent = rv.summary
    const full = document.createElement('div')
    full.className = 'rfull'
    full.innerHTML = mdToHtml(rv.full)
    d.appendChild(head)
    d.appendChild(full)
    d.onclick = () => {
      bucket.rShut = !(bucket.rShut === true)
      d.classList.toggle('shut')
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
  updateSendState() // 桶出现/收口即时反映到送钮（busy 灰条 / 空闲恢复）
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

// ---------- 事件流（delta + tool 相进桶；letter 快照收口；status 清画布） ----------

function openStream() {
  const es = new EventSource('/api/events')
  es.onopen = () => {
    $('conn')?.classList.add('on')
    // 快照追平：事件流无回放（SSE 断线/服务端重启窗口会丢 status/letter）——
    // 凡连接建立/重连成功，live 桶与忙态一律作废、以仓库历史为准重建（delta
    // live-only 纪律的另一半：断帧不补，快照自愈）。
    for (const id of Object.keys(liveBuckets)) clearBucket(liveBuckets, id)
    roundBusy = false
    void loadAgents()
    if (currentAgentId !== '') void loadContext(currentAgentId)
    schedulePaint()
    updateSendState()
  }
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
    if (ev.agentId === currentAgentId) {
      // 收信只刷新历史（新 user 行上屏）；桶归轮生命周期管，此处不动。
      void loadContext(currentAgentId).catch((e) => console.error('[ui] loadContext@letter', e))
      void loadAgents()
    }
    return
  }
  if (ev.type === 'status') {
    void loadAgents()
    if (ev.agentId === currentAgentId && ev.to === 'thinking') roundBusy = true
    else if (ev.agentId === currentAgentId && (ev.to === 'holding' || ev.to === 'idle' || ev.to === 'interrupted')) {
      // 轮末收口三步全部**同步**（快照拉取失败也绝不让光标/灰钮滞留）：
      // 忙态解除 + 桶清 + 光标退场，然后才尽力刷新历史。
      roundBusy = false
      clearBucket(liveBuckets, ev.agentId)
      schedulePaint()
      void loadContext(currentAgentId).catch((e) => console.error('[ui] loadContext@holding', e))
    }
    if (ev.to === 'thinking') clearBucket(liveBuckets, ev.agentId) // 新轮开画布
    if (ev.agentId === watchAgentId && (ev.to === 'holding' || ev.to === 'idle')) schedulePaint() // 抽屉定格保留到下轮
    updateSendState()
  }
}

// ---------- 会话动作 ----------

let sendAllowed = false
let roundBusy = false // thinking→holding 之间 = 回复未完整收口，送钮灰防误触
let sendInFlight = false

function updateSendState() {
  const busy = sendInFlight || roundBusy || (currentAgentId !== '' && liveBuckets[currentAgentId] !== undefined)
  const canSend = sendAllowed && !busy
  $('sendBtn').disabled = !canSend
  $('input').disabled = !sendAllowed
  const a = currentAgent()
  $('input').placeholder = !sendAllowed ? '选择一位后代开始对话…'
    : busy ? `${String(a?.name ?? a?.id ?? '')} 回复中——本轮收口后可继续（消息会合并投递）`
    : `向 ${a?.name ?? a?.id ?? ''} 发消息（Enter 发送，Shift+Enter 换行）`
}

function applyActions(agent) {
  sendAllowed = agent !== null && agent !== undefined && deriveActions(agent).send !== 'off'
  updateSendState()
}

async function selectAgent(id) {
  currentAgentId = id
  roundBusy = false // 换窗不复用旧窗的轮忙态（下个 status 事件自然校正）
  // 即点即清屏：旧窗内容零残留（空态占位），数据两请求**并行**拉取——
  // 历史窗口渲染不依赖 agents 行集，串行 await 会让远程主机延迟翻倍。
  timeline.innerHTML = ''
  timeline.appendChild(emptyHint())
  sendAllowed = false
  updateSendState()
  const agentsP = fetch('/api/agents').then((r) => r.json())
  const ctxP = fetch('/api/agents/' + encodeURIComponent(id) + '/context').then((r) => r.json())
  const pair = await Promise.all([agentsP, ctxP]).catch((e) => {
    console.error('[ui] selectAgent 数据拉取失败', e)
    return null
  })
  if (pair === null) return
  const [agents, ctx] = pair
  if (id !== currentAgentId) return // 等待期已切窗：本轮作废
  agentsCache = agents
  const a = agents.find((x) => x.id === id) ?? null
  applyActions(a)
  renderComposerMeta()
  renderQuickBox()
  const msgs = ctx.messages || []
  renderTimeline(routeLetters(msgs, id, ROOT_ID, nameOf))
  ctxWindow = Number(ctx.contextWindow) > 0 ? Number(ctx.contextWindow) : 1000000
  paintCtxBar(contextRatio(msgs, ctxWindow))
  if (a !== null && a.parentId === null) {
    $('turnStats').hidden = true // 根箱无"轮"语义（扮演接口不跑 LLM 轮）
  } else {
    const st = turnStats(msgs)
    const ts = $('turnStats')
    ts.hidden = !(st.durationS > 0)
    ts.textContent = st.durationS > 0 ? `最近一轮耗时 ${st.durationS.toFixed(1)}s` : ''
  }
  schedulePaint()
  void loadAgents(agents) // 树重绘复用同一次拉取（高亮换人）
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
  sendInFlight = true
  updateSendState()
  try {
    await fetch('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: currentAgentId, text }) })
  } finally {
    sendInFlight = false
    updateSendState()
  }
}

async function createAgent() {
  const className = $('createClass').value
  const userPrompt = $('createPrompt').value.trim() || '你好，请做一个简短的自我介绍。'
  const body = { className, userPrompt }
  const model = $('createModel').value // 空 = 不显式（落类基因>父继承>家学链）
  if (model) body.model = model
  const name = $('createName').value.trim() // 空 = 派生 类名-N
  if (name !== '') body.name = name
  const r = await fetch('/api/instantiate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await r.json()
  if (data.error !== undefined) { alert(String(data.error)); return }
  if (data.agentId) { $('createPrompt').value = ''; $('createName').value = ''; void selectAgent(data.agentId) }
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
