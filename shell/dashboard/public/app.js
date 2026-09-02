// stem dashboard 前端（自包含 ES module；族谱行序/字形复用 view.js 纯函数核心）
import { computeTreeRows, statusGlyph, statusTone, truncate } from '/view.js'

const $ = (sel) => document.querySelector(sel)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const num = (n) => (n ?? 0).toLocaleString('zh')
const fmtAt = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—')
const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b > 1024 ? (b / 1024).toFixed(0) + ' KB' : b + ' B')
const get = async (url) => { const r = await fetch(url); return r.json() }
const post = async (url, body) => (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()

let agentsCache = []
let msgState = { agentId: '', offset: 0, limit: 100, total: 0 }
let rawState = { table: 'instances', offset: 0, limit: 50, total: 0 }
let selectedAgent = ''

// ---------- tabs ----------
$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn) return
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b === btn)
  for (const p of document.querySelectorAll('.panel')) p.classList.toggle('on', p.id === `panel-${btn.dataset.tab}`)
  loadTab(btn.dataset.tab)
})

async function loadTab(tab) {
  if (tab === 'tree') await renderTree()
  if (tab === 'tokens') await renderTokens()
  if (tab === 'inventory') await renderInventory()
  if (tab === 'messages') await renderMessages()
  if (tab === 'raw') await renderRaw()
  if (tab === 'cleanup') await renderCleanup()
}

// ---------- 顶卡 ----------
async function renderCards() {
  const [health, stats] = await Promise.all([get('/api/health'), get('/api/stats')])
  const env = $('#env')
  env.innerHTML = `${esc(health.project)} · <span class="badge ${health.db ? 'live' : 'nowrite'}">${health.db ? 'DB 就绪' : 'DB 未出生'}</span>` +
    `<span class="badge ${health.allowWrite ? 'write' : 'nowrite'}">${health.allowWrite ? '⚠ 写姿态' : '只读'}</span>`
  const cards = $('#cards')
  if (!stats.db) {
    cards.innerHTML = `<div class="card"><h3>空间尚无 DB</h3><div class="sub">该空间还没跑过任何 shell（WebUI/CLI 首次启动即诞生）</div></div>`
    return
  }
  const bs = Object.entries(stats.instances.byStatus).map(([k, v]) => `${statusGlyph(k)}${v}`).join(' ')
  cards.innerHTML = `
    <div class="card"><h3>语料行</h3><div class="num">${num(stats.messages.valid)}</div><div class="sub">有效 · 归档 ${num(stats.messages.archived)} · 共 ${num(stats.messages.total)}</div></div>
    <div class="card"><h3>TOKEN（真实计量）</h3><div class="num">${num(stats.tokensValid)}</div><div class="sub">有效口径 · 含归档 ${num(stats.tokensTotal)}</div></div>
    <div class="card"><h3>实例</h3><div class="num">${num(stats.instances.total)}</div><div class="sub">${bs || '—'} · 空间 ${stats.spaces}</div></div>
    <div class="card"><h3>DB</h3><div class="num">${fmtSize(stats.dbBytes)}</div><div class="sub">schema v${stats.schemaVersion} · 最近活动 ${fmtAt(stats.lastActivity)}</div></div>`
}

// ---------- 族谱树 ----------
async function renderTree() {
  agentsCache = await get('/api/agents')
  const rows = computeTreeRows(agentsCache)
  const box = $('#tree')
  if (rows.length === 0) { box.innerHTML = '<div class="meta dim" style="padding:10px">（DB 中尚无实例）</div>'; return }
  box.innerHTML = rows.map((r) => {
    if (r.type === 'more') return `<div class="trow ghost"><span class="indent">${'  '.repeat(r.depth)}</span><span class="meta">… +${r.count}${r.kind === 'depth' ? '（折叠后代）' : '（折叠兄弟）'}</span></div>`
    const a = r.row
    const tone = statusTone(a.status)
    const bits = [a.classRef, a.model ?? '', a.msgs + ' 行', num(a.tokens) + ' tk', a.turnCount + ' 轮', a.totalCost > 0 ? 'cost ' + a.totalCost.toFixed(2) : ''].filter(Boolean).join(' · ')
    return `<div class="trow ${selectedAgent === a.id ? 'selected' : ''}" data-id="${esc(a.id)}">
      <span class="indent">${'│ '.repeat(r.depth)}${r.join ? '└' : ''}</span>
      <span class="glyph g-${tone}">${statusGlyph(a.status)}</span>
      <span class="id">${esc(a.id)}</span>
      <span class="meta">${esc(bits)}</span>
      <span class="prompt">${esc(truncate(a.lastPrompt ?? '', 36))}</span>
    </div>`
  }).join('')
  box.querySelectorAll('.trow[data-id]').forEach((el) => el.addEventListener('click', () => {
    selectedAgent = el.dataset.id
    renderTree()
  }))
}

// ---------- token 账目 ----------
async function renderTokens() {
  const t = await get('/api/tokens')
  const agentName = new Map(agentsCache.map((a) => [a.id, a.classRef ?? a.id]))
  const max = Math.max(1, ...t.byAgent.map((x) => x.tokens))
  const byAgent = t.byAgent.map((x) => {
    const r = x.byRole ?? {}, w = (v) => Math.max(0, Math.round((v / max) * 240))
    const stack = `<span class="stack" title="user ${num(r.user ?? 0)} / assistant ${num(r.assistant ?? 0)} / tool ${num(r.tool ?? 0)} / system ${num(r.system ?? 0)}">
      <i class="hbar seg-r" style="width:${w(r.user ?? 0)}px"></i><i class="hbar" style="width:${w(r.assistant ?? 0)}px"></i>
      <i class="hbar seg-t" style="width:${w(r.tool ?? 0)}px"></i><i class="hbar seg-s" style="width:${w(r.system ?? 0)}px"></i></span>`
    const tags = Object.entries(x.byTag ?? {}).map(([k, v]) => `${k} ${num(v)}`).join(' · ')
    return `<tr><td>${esc(agentName.get(x.agentId) ?? '')} <span class="dim">${esc(x.agentId)}</span></td>
      <td class="num">${num(x.msgs)}</td><td class="num">${num(x.tokens)}</td><td>${stack}</td><td class="dim">${esc(tags)}</td></tr>`
  }).join('')
  const days = t.byDay.map((d) => {
    const w = Math.max(2, Math.round((d.tokens / Math.max(1, ...t.byDay.map((x) => x.tokens))) * 260))
    return `<tr><td>${esc(d.day)}</td><td class="num">${num(d.msgs)}</td><td class="num">${num(d.tokens)}</td><td><i class="hbar" style="width:${w}px"></i></td></tr>`
  }).join('')
  $('#tokens-body').innerHTML = `
    <div class="hint">总账：${num(t.total.msgs)} 行 / ${num(t.total.tokens)} tokens（图例：<i class="hbar seg-r"></i> user · <i class="hbar"></i> assistant · <i class="hbar seg-t"></i> tool · <i class="hbar seg-s"></i> system）</div>
    <table><tr><th>agent</th><th class="num">行</th><th class="num">tokens</th><th>角色堆叠</th><th>tag 分项</th></tr>${byAgent || '<tr><td colspan=5 class="dim">空</td></tr>'}</table>
    <h4 class="dim" style="margin-top:14px">按日</h4>
    <table><tr><th>日</th><th class="num">行</th><th class="num">tokens</th><th></th></tr>${days || '<tr><td colspan=4 class="dim">空</td></tr>'}</table>`
}

// ---------- 资源清单 ----------
async function renderInventory() {
  const inv = await get('/api/inventory')
  const issues = (inv.initIssues ?? []).length > 0
    ? `<div class="issues"><b>装载 issue（fail-soft 已跳过，不炸启动）</b>${inv.initIssues.map((i) => `<div>[${esc(i.kind)}] ${esc(i.file)} — ${esc(i.message)}</div>`).join('')}</div>` : ''
  const toolsByKind = { internal: [], extension: [], custom: [] }
  for (const t of inv.tools) (toolsByKind[t.kind] ?? toolsByKind.internal).push(t)
  const toolRow = (t) => `<tr><td class="id">${esc(t.id)}</td><td>${esc(t.accessKey)}</td>
    <td>${t.visibleToUser0 ? '<span class="g-accent">可见</span>' : '<span class="dim">隐藏/deny</span>'}</td><td class="dim">${esc(truncate(t.description, 90))}</td></tr>`
  const classes = inv.classes.map((c) => `<tr><td><span class="badge-l ${c.layer}">${c.layer}</span>${esc(c.name)}${c.panel ? '<span class="tag">panel</span>' : ''}</td>
    <td>${c.model ? esc(c.model) : '<span class="dim">继承</span>'}</td><td class="num">${c.toolKeys}</td><td class="dim">${esc(truncate(c.description, 80))}</td></tr>`).join('')
  const providers = Object.entries(inv.providers ?? {}).map(([name, p]) =>
    `<tr><td>${esc(name)}</td><td class="dim">${esc(p.baseUrl)}</td><td>${p.keyPresent ? '<span class="g-accent">key ✓</span>' : '<span class="g-alert">key 缺失</span>'}</td><td class="dim">${(p.models ?? []).join(', ') || '全部'}</td></tr>`).join('')
  $('#inv-body').innerHTML = `${issues}
    <div class="bar"><span class="hint">家学锚点 <b class="g-accent">${esc(inv.homeModel ?? '—')}</b> · extensions ${esc(JSON.stringify(inv.extensions ?? '默认'))} · 标本装配于 ${fmtAt(inv.assembledAt)}</span></div>
    <h4><span class="badge-l extension">extension</span>工具（点名启用）</h4>
    <table><tr><th>id</th><th>访问键</th><th>user0</th><th>说明</th></tr>${toolsByKind.extension.map(toolRow).join('') || '<tr><td colspan=4 class="dim">无</td></tr>'}</table>
    <h4><span class="badge-l custom">custom</span>工具（.stem 自动扫描）</h4>
    <table><tr><th>id</th><th>访问键</th><th>user0</th><th>说明</th></tr>${toolsByKind.custom.map(toolRow).join('') || '<tr><td colspan=4 class="dim">无</td></tr>'}</table>
    <h4><span class="badge-l internal">internal</span>系统工具（core 恒在，默认 ignore 隐藏）</h4>
    <table><tr><th>id</th><th>访问键</th><th>user0</th><th>说明</th></tr>${toolsByKind.internal.map(toolRow).join('')}</table>
    <h4>类模板（族谱基因面）</h4>
    <table><tr><th>类</th><th>基因模型</th><th class="num">tools 键</th><th>说明</th></tr>${classes}</table>
    <h4>上下文策略（记忆机制清单）</h4>
    <table><tr><th>策略</th><th>process</th><th>actions</th><th>说明</th></tr>${
      (inv.strategies ?? []).map((s) => `<tr><td><span class="badge-l ${s.layer}">${s.layer}</span>${esc(s.name)}</td>
      <td>${s.hasProcess ? '<span class="g-accent">异步许可</span>' : '<span class="dim">纯组装</span>'}</td>
      <td class="dim">${s.actions.join(', ') || '—'}</td><td class="dim">${esc(truncate(s.note ?? '', 80))}</td></tr>`).join('') || '<tr><td colspan=4 class="dim">无</td></tr>'
    }</table>
    <h4>providers（网关注册表）</h4>
    <table><tr><th>名称</th><th>端点</th><th>密钥</th><th>白名单</th></tr>${providers || '<tr><td colspan=4 class="dim">无</td></tr>'}</table>`
}
$('#inv-refresh')?.addEventListener('click', async () => { await get('/api/inventory?refresh=1'); renderInventory() })

// ---------- 语料浏览 ----------
function agentOptions() {
  const sel = $('#msg-agent')
  if (sel.options.length <= 1) {
    for (const a of agentsCache) sel.add(new Option(`${a.id} (${a.classRef})`, a.id))
    sel.value = msgState.agentId
  }
}
async function renderMessages() {
  if (agentsCache.length === 0) agentsCache = await get('/api/agents')
  agentOptions()
  const q = new URLSearchParams({ limit: msgState.limit, offset: msgState.offset, ...(msgState.agentId ? { agentId: msgState.agentId } : {}), ...(selectedAgent && !msgState.agentId ? { agentId: selectedAgent } : {}) })
  if ($('#msg-arch').checked) q.set('archived', '1')
  const data = await get('/api/messages?' + q)
  msgState.total = data.total
  const rows = data.rows.map((m) => `<tr class="${!m.valid ? 'dead' : ''}"><td class="dim">${esc(m.id)}</td>
    <td><span class="role-${esc(m.role)}">${esc(m.role)}</span>${m.tag ? `<span class="tag">${esc(m.tag)}</span>` : ''}${m.archived ? '<span class="tag">arch</span>' : ''}</td>
    <td class="dim">${esc(m.agentId)}${m.from ? ` ← ${esc(m.from)}` : ''}</td>
    <td class="num">${m.turn}.${m.indexInTurn}</td><td class="num">${num(m.tokens)}</td>
    <td>${esc(m.preview)}</td><td class="dim">${fmtAt(m.at)}</td></tr>`).join('')
  $('#msg-body').innerHTML = `<table><tr><th>id</th><th>role</th><th>agent</th><th>轮</th><th class="num">tk</th><th>内容预览</th><th>时间</th></tr>${rows || '<tr><td colspan=7 class="dim">空</td></tr>'}</table>`
  $('#msg-pos').textContent = `${msgState.offset + 1}-${Math.min(msgState.offset + msgState.limit, data.total)} / ${num(data.total)}`
}
$('#msg-agent')?.addEventListener('change', (e) => { msgState.agentId = e.target.value; msgState.offset = 0; renderMessages() })
$('#msg-arch')?.addEventListener('change', renderMessages)
$('#msg-prev')?.addEventListener('click', () => { msgState.offset = Math.max(0, msgState.offset - msgState.limit); renderMessages() })
$('#msg-next')?.addEventListener('click', () => { if (msgState.offset + msgState.limit < msgState.total) { msgState.offset += msgState.limit; renderMessages() } })

// ---------- 原表 ----------
async function renderRaw() {
  rawState.table = $('#raw-table').value
  const data = await get(`/api/raw?table=${rawState.table}&limit=${rawState.limit}&offset=${rawState.offset}`)
  rawState.total = data.total
  const head = data.columns.map((c) => `<th>${esc(c)}</th>`).join('')
  const rows = data.rows.map((r) => `<tr>${data.columns.map((c) => `<td><pre class="json" style="max-height:120px;margin:0">${esc(String(r[c] ?? ''))}</pre></td>`).join('')}</tr>`).join('')
  $('#raw-body').innerHTML = `<table>${head ? `<tr>${head}</tr>` : ''}${rows || '<tr><td class="dim">空</td></tr>'}</table>`
  $('#raw-pos').textContent = `${rawState.offset + 1}-${Math.min(rawState.offset + rawState.limit, data.total)} / ${num(data.total)}`
}
$('#raw-table')?.addEventListener('change', () => { rawState.offset = 0; renderRaw() })
$('#raw-prev')?.addEventListener('click', () => { rawState.offset = Math.max(0, rawState.offset - rawState.limit); renderRaw() })
$('#raw-next')?.addEventListener('click', () => { if (rawState.offset + rawState.limit < rawState.total) { rawState.offset += rawState.limit; renderRaw() } })

// ---------- 清理 ----------
let armed = null // 双确认状态机：首次点击装载，二次点击执行
async function renderCleanup() {
  const { preview, allowWrite } = await get('/api/cleanup/preview')
  $('#cl-mode').innerHTML = allowWrite ? '<span class="g-alert">⚠ 写姿态开启（--allow-write）</span>' : '<span class="dim">只读姿态：动作按钮将拒绝执行（重启加 --allow-write 解锁）</span>'
  $('#cl-preview').innerHTML = `
    <table>
      <tr><th>孤儿消息箱（无实例行）</th><td class="num">${preview.orphanAgents.length} 箱 / ${num(preview.orphanRows)} 行</td><td class="dim">${esc(preview.orphanAgents.slice(0, 8).join(', '))}${preview.orphanAgents.length > 8 ? '…' : ''}</td></tr>
      <tr><th>terminated 实例（语料 GC 候选）</th><td class="num">${preview.terminatedAgents.length} 个 / ${num(preview.terminatedRows)} 行</td><td class="dim">${esc(preview.terminatedAgents.join(', '))}</td></tr>
      <tr><th>归档行（archived=1，恢复不加载）</th><td class="num">${num(preview.archivedRows)} 行</td><td class="dim">「销毁保语料」设计留档</td></tr>
      <tr><th>VACUUM 可回收</th><td class="num">${fmtSize(preview.reclaimableBytes)}</td><td class="dim">freelist × page_size</td></tr>
    </table>`
  const dead = agentsCache.filter((a) => a.status === 'terminated')
  const actions = [
    { id: 'gc-orphans', title: 'GC 孤儿箱', desc: '删除 instances 表已无对应行的消息箱（历史残留语料）', rows: `${num(preview.orphanRows)} 行` },
    { id: 'gc-terminated', title: 'GC terminated 语料', desc: '删除 terminated 实例的全部消息行；实例墓碑保留（族谱可考）', rows: `${num(preview.terminatedRows)} 行` },
    { id: 'purge-agent', title: '定点销毁', desc: '删除指定实例行 + 其全部语料（非 terminated 需勾选风险）', rows: dead.length ? `${dead.length} 个已终止可选` : '' },
    { id: 'vacuum', title: 'VACUUM 压缩', desc: '回收 freelist 页面，DB 物理缩容', rows: fmtSize(preview.reclaimableBytes) },
  ]
  $('#cl-actions').innerHTML = `<div class="cl-group">` + actions.map((a) => `
    <div class="cl-card"><h4>${a.title}</h4><p>${a.desc}</p>
      ${a.id === 'purge-agent' ? `<select class="picker" id="cl-agent">${dead.map((d) => `<option value="${esc(d.id)}">${esc(d.id)} (${esc(d.classRef)})</option>`).join('')}</select>` : ''}
      <div>${a.rows ? `<span class="dim">${a.rows} · </span>` : ''}<button data-act="${a.id}">执行</button></div>
    </div>`).join('') + `</div>`
  for (const btn of document.querySelectorAll('#cl-actions button[data-act]')) {
    btn.addEventListener('click', async () => {
      const act = btn.dataset.act
      if (armed !== act) {
        armed = act
        for (const b of document.querySelectorAll('#cl-actions button')) { b.classList.remove('confirm'); b.textContent = '执行' }
        btn.classList.add('confirm'); btn.textContent = '⚠ 再点确认'
        setTimeout(() => { if (armed === act) { armed = null; btn.classList.remove('confirm'); btn.textContent = '执行' } }, 4000)
        return
      }
      armed = null
      const body = { action: act, confirm: 'yes' }
      if (act === 'purge-agent') {
        const sel = $('#cl-agent')
        if (!sel?.value) { showResult({ ok: false, note: '下拉无 terminated 实例可定点（先回族谱页刷新）' }); return }
        body.agentId = sel.value
      }
      showResult(await post('/api/cleanup', body))
      btn.textContent = '执行'
      await renderCards(); await renderCleanup()
    })
  }
}
function showResult(r) {
  const el = $('#cl-result')
  el.classList.remove('hidden')
  el.innerHTML = `<span class="${r.ok ? 'g-accent' : 'g-alert'}">${r.ok ? '✔' : '✗'} ${esc(r.action)}</span> ${r.deletedRows ? `删除 ${num(r.deletedRows)} 行 · ` : ''}${esc(r.note ?? '')}`
}

$('#tree-refresh')?.addEventListener('click', renderTree)
$('#tokens-refresh')?.addEventListener('click', renderTokens)
$('#cl-refresh')?.addEventListener('click', renderCleanup)

// 启动
renderCards().then(renderTree)
