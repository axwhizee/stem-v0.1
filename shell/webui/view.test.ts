// ============================================================
// shell/webui/view.test.ts —— 视图纯函数矩阵（S6 批 2，R8/R9）
//
// 覆盖：汉字字形表（无 emoji/几何字符）/ sender 剥壳截断 /
// 第一视角归位 routeLetters（根窗反相 + ask/摘要/invalid）/
// git 风行序 computeTreeRows（DFS/泳道/折叠/家族色）/ 动作三态。
// 纯函数零 DOM：浏览器与 node 共用同一实现，UI 层不携带逻辑。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { LiveBucket, LiveBuckets, LiveTool, TreeRow } from './view.js'

type NodeRow = Extract<TreeRow, { type: 'node' }>
const isNode = (r: TreeRow): r is NodeRow => r.type === 'node'

import {
  ACT_GLYPH,
  ROOT_ID,
  STATUS_GLYPH,
  applyStreamEvent,
  clearBucket,
  computeTreeRows,
  contextRatio,
  createLiveBuckets,
  deriveActions,
  idOrder,
  composerMeta,
  infoRows,
  mdToHtml,
  menuItems,
  ratioTone,
  reasoningView,
  relativeTime,
  routeLetters,
  statusGlyph,
  statusTone,
  stripSender,
  toolFold,
  truncate,
  turnStats,
} from './view.js'

/** CJK 统一表意文字基本区判定（R8 禁 emoji/几何字符的实现级验收）。 */
const isHan = (ch: string) => /^[\u4e00-\u9fff]$/.test(ch)

describe('字形表（R8）', () => {
  test('状态/动作字形全汉字且单字', () => {
    for (const g of Object.values(STATUS_GLYPH)) assert.ok(isHan(g), g)
    for (const g of Object.values(ACT_GLYPH)) assert.ok(isHan(g) && g.length === 1, g)
  })
  test('状态三态映射：thinking/holding=active、interrupted=alert、其余 ready', () => {
    assert.equal(statusTone('thinking'), 'active')
    assert.equal(statusTone('holding'), 'active')
    assert.equal(statusTone('interrupted'), 'alert')
    assert.equal(statusTone('idle'), 'ready')
    assert.equal(statusGlyph('idle'), '静')
    assert.equal(statusGlyph('nope'), '·')
  })
})

describe('sender 剥壳与截断', () => {
  test('stripSender 往返', () => {
    assert.deepEqual(stripSender('<sender id="a1">你好</sender>'), { sender: 'a1', text: '你好' }) // 旧形兼容
    assert.deepEqual(stripSender('<sender id="w#0-1" at="260908.1234">你好</sender>'), { sender: 'w#0-1', text: '你好' }) // B4 新形
    assert.deepEqual(stripSender('裸文本'), { sender: '', text: '裸文本' })
    assert.deepEqual(stripSender(''), { sender: '', text: '' })
  })
  test('truncate 折叠空白 + 30 字截断带省略号', () => {
    assert.equal(truncate(' 多   行 \n 文本 '), '多 行 文本')
    const long = '字'.repeat(40)
    const out = truncate(long)
    assert.equal(out.length, 31) // 30 + …
    assert.ok(out.endsWith('…'))
  })
})

describe('routeLetters（R9 第一视角归位）', () => {
  const msg = (over: Record<string, unknown>) => ({ valid: true, ...over })

  test('常规 agent 窗：根来信=右我、兄弟来信=左、assistant=agent、tool/摘要各归其位', () => {
    const items = routeLetters(
      [
        msg({ role: 'user', content: '<sender id="user#0" at="260908.1234">写个测试</sender>' }),
        msg({ role: 'assistant', content: '好的' }),
        msg({ role: 'user', content: '<sender id="buddy#b2">请对齐口径</sender>' }),
        msg({ role: 'tool', content: 'echo ok' }),
        msg({ role: 'user', content: '旧消息', tag: 'summary' }),
        msg({ role: 'system', content: 'sys prompt' }),
        msg({ role: 'assistant', content: 'invalid 不渲染', valid: false }),
      ],
      'a1',
    )
    assert.deepEqual(items.map((i) => i.kind), ['msg', 'msg', 'msg', 'tool', 'meta'])
    assert.equal(items[0]?.side, 'me')
    assert.equal(items[0]?.who, '我')
    assert.equal(items[1]?.side, 'agent')
    assert.equal(items[1]?.who, 'a1')
    assert.equal(items[2]?.side, 'me') // 收到的一切消息（含其它 agent）都在右（agent 自己回复在左的规则）
    assert.equal(items[2]?.who, '来自 buddy#b2')
    assert.equal(items[3]?.text, 'echo ok')
    assert.equal(items[4]?.icon, '摘')
  })

  test('根窗反相：assistant=人类发言（我/右）、user=后代回信（左）', () => {
    const items = routeLetters(
      [
        msg({ role: 'assistant', content: '帮我看看' }),
        msg({ role: 'user', content: '<sender id="watcher#a1" at="260908.1235">看完了</sender>' }),
      ],
      ROOT_ID,
    )
    assert.equal(items[0]?.side, 'me')
    assert.equal(items[0]?.who, '我')
    assert.equal(items[1]?.side, 'them')
    assert.equal(items[1]?.who, '来自 watcher#a1')
  })

  test('agent 窗 assistant 发送者 = 全名 name#id（nameOf 解析）；无解析器回退裸 id', () => {
    const rows = routeLetters(
      [{ role: 'assistant', content: 'hi', valid: true }],
      '0-1-1', ROOT_ID, (id) => (id === '0-1-1' ? 'verify-child' : undefined),
    )
    assert.equal(rows[0]?.who, 'verify-child#0-1-1')
    assert.equal(routeLetters([{ role: 'assistant', content: 'hi', valid: true }], '0-7')[0]?.who, '0-7')
  })
  test('纯 tool-call 轮（空正文 assistant）跳过；tool 行携带来源 who 与关联工具名', () => {
    const rows = routeLetters(
      [
        { role: 'assistant', content: ' ', valid: true, toolCalls: [{ id: 'c1', name: 'bash' }, { id: 'c2', name: 'list_agents' }] },
        { role: 'tool', content: '祖先链: yes', valid: true, toolCallId: 'c1' },
        { role: 'tool', content: 'agent 类列表', valid: true, toolCallId: 'c2' },
        { role: 'assistant', content: '有正文', valid: true },
      ],
      '0-1-1', ROOT_ID, (id) => (id === '0-1-1' ? 'verify-child' : undefined),
    )
    assert.equal(rows.length, 3)
    assert.equal(rows[0]?.kind, 'tool')
    assert.equal(rows[0]?.who, 'verify-child#0-1-1')
    assert.equal(rows[0]?.toolName, 'bash')
    assert.equal(rows[1]?.toolName, 'list_agents')
    assert.equal(rows[2]?.kind, 'msg')
  })

  test('access_request 出 ask 项（归审面板，不入正文流）', () => {
    const items = routeLetters([msg({ role: 'user', content: '<access_request id="r1" accessKey="bash" agentId="a1">' })], ROOT_ID)
    assert.equal(items[0]?.kind, 'ask')
    assert.equal(items[0]?.icon, '审')
  })
})

describe('computeTreeRows（git 风行序：DFS/泳道/折叠）', () => {
  const agent = (id: string, parentId: string | null) => ({ id, parentId, name: id, classRef: 'c', status: 'idle' })

  test('线性链：深度逐层 +1、连线逐行接父泳道、无穿越竖线', () => {
    const rows = computeTreeRows([agent(ROOT_ID, null), agent('a', ROOT_ID), agent('b', 'a')])
    const nodes = rows.filter((r) => r.type === 'node')
    assert.deepEqual(nodes.map((r) => r.id), [ROOT_ID, 'a', 'b'])
    assert.deepEqual(nodes.map((r) => r.lane), [0, 1, 2])
    assert.deepEqual(nodes.map((r) => r.parentLane), [null, 0, 1])
    assert.ok(nodes.every((r) => r.passThrough.length === 0), '独子链无祖先竖线穿越')
  })

  test('分叉：先序 DFS、兄续弟断的竖线穿越、根族=-1 顶层支系轮色', () => {
    const rows = computeTreeRows([
      agent(ROOT_ID, null),
      agent('p', ROOT_ID),
      agent('p1', 'p'),
      agent('p2', 'p'),
      agent('q', ROOT_ID),
    ])
    assert.deepEqual(rows.filter(isNode).map((r) => r.id), [ROOT_ID, 'p', 'p1', 'p2', 'q'])
    const p1 = rows.find((r): r is NodeRow => r.type === 'node' && r.id === 'p1')
    assert.ok(p1 !== undefined && p1.passThrough.includes(1), 'p1 行穿越父亲 p 的剩余分支竖线')
    const p2 = rows.find((r): r is NodeRow => r.type === 'node' && r.id === 'p2')
    assert.ok(p2 !== undefined && p2.passThrough.includes(1), 'p2 行仍处 p 的延伸段（全段画满无断点）')
    const q = rows.find((r): r is NodeRow => r.type === 'node' && r.id === 'q')
    assert.equal(q?.passThrough.includes(1), false, 'q 行起 p 支系已断，无残留竖线')
    const fams = rows.filter(isNode).filter((r) => r.depth === 1).map((r) => r.family)
    assert.deepEqual(fams, [0, 1], '两顶层支系轮色')
    assert.equal(rows.find(isNode)?.family, -1)
  })

  test('溢出折叠：深 >4 → 后代一收「…+n」；同父 >6 → 留 5 + 兄弟收口', () => {
    const deep = [{ id: ROOT_ID, parentId: null }, ...Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, parentId: i === 0 ? ROOT_ID : `d${i - 1}`, status: 'idle' }))]
    const rowsDeep = computeTreeRows(deep)
    const more = rowsDeep.find((r) => r.type === 'more')
    assert.ok(more, '深度溢出折叠行存在')
    assert.equal(more.kind, 'depth')
    assert.equal(rowsDeep.filter((r) => r.type === 'node').every((r) => r.lane <= 4), true, '展开行不超深 4')

    const sib = [{ id: ROOT_ID, parentId: null }, ...Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, parentId: ROOT_ID, status: 'idle' }))]
    const rowsSib = computeTreeRows(sib)
    const moreS = rowsSib.find((r) => r.type === 'more')
    assert.ok(moreS && moreS.kind === 'siblings' && moreS.count === 3, `兄弟折叠数（实际 ${JSON.stringify(moreS)}）`)
    assert.equal(moreS.descendants, 3, '无子树的折叠后代 = 自身数')
  })

  test('多根（孤儿行）不崩溃；空输入 → 空输出', () => {
    assert.deepEqual(computeTreeRows([]), [])
    const rows = computeTreeRows([agent('orphan', null), agent(ROOT_ID, null)])
    assert.equal((rows[0] as NodeRow).id, ROOT_ID, '约定根恒先序')
  })
})

describe('deriveActions（能力数据驱动，无 agent 特判）', () => {
  test('未选中全遮罩', () => {
    assert.deepEqual(deriveActions(null), { send: 'off', interrupt: 'off', compact: 'off', terminate: 'off', model: 'off' })
  })
  test('根：毁/停/缩/送遮罩（无祖先/面板态/非对话窗口），模可动', () => {
    const a = deriveActions({ id: ROOT_ID, parentId: null })
    assert.equal(a.terminate, 'off')
    assert.equal(a.interrupt, 'off')
    assert.equal(a.send, 'off')
    assert.equal(a.model, 'ready')
  })
  test('普通 agent：send=激活、其余可用、毁=可用（销毁权在根）', () => {
    const a = deriveActions({ id: 'x', parentId: ROOT_ID })
    assert.equal(a.send, 'active')
    assert.equal(a.terminate, 'ready')
  })
})

// ---------- 5. 流式 live 桶 reducer ----------

describe('applyStreamEvent（delta live-only）', () => {
  const bk = (b: LiveBuckets, id: string): LiveBucket => {
    const v = b[id]
    assert.ok(v !== undefined, `bucket ${id} 应在`)
    return v
  }
  const tl = (b: LiveBuckets, id: string): LiveTool[] => bk(b, id).tools
  test('text/reasoning delta 按 agent 分桶累积；其余事件穿越无副作用', () => {
    const b = createLiveBuckets()
    applyStreamEvent(b, { type: 'stream', agentId: 'a1', event: { type: 'text-delta', text: '你好' } })
    applyStreamEvent(b, { type: 'stream', agentId: 'a1', event: { type: 'text-delta', text: '世界' } })
    applyStreamEvent(b, { type: 'stream', agentId: 'a2', event: { type: 'reasoning-delta', text: '想想' } })
    applyStreamEvent(b, { type: 'letter', agentId: 'a1' })
    applyStreamEvent(b, { type: 'status', agentId: 'a1', to: 'thinking' })
    applyStreamEvent(b, null)
    applyStreamEvent(b, undefined)
    assert.equal(bk(b, 'a1').text, '你好世界')
    assert.equal(bk(b, 'a1').reasoning, '')
    assert.equal(bk(b, 'a2').reasoning, '想想')
  })
  test('tool 相位：called 开卡 → success 收口带时刻；error 同理；孤儿 success 也上账', () => {
    const b = createLiveBuckets()
    applyStreamEvent(b, { type: 'tool', agentId: 'a1', tool: 'bash', phase: 'called', at: 1000 })
    applyStreamEvent(b, { type: 'tool', agentId: 'a1', tool: 'bash', phase: 'success', at: 3500 })
    applyStreamEvent(b, { type: 'tool', agentId: 'a1', tool: 'web_search', phase: 'error', at: 9000 })
    const t = tl(b, 'a1')
    assert.equal(t.length, 2)
    assert.deepEqual([t[0]?.name, t[0]?.phase, t[0]?.at, t[0]?.doneAt], ['bash', 'success', 1000, 3500])
    assert.deepEqual([t[1]?.name, t[1]?.phase, t[1]?.at, t[1]?.doneAt], ['web_search', 'error', 9000, 9000])
  })
  test('同名并行 FIFO 后进先收口（队尾先匹配）', () => {
    const b = createLiveBuckets()
    applyStreamEvent(b, { type: 'tool', agentId: 'a', tool: 'bash', phase: 'called', at: 1 })
    applyStreamEvent(b, { type: 'tool', agentId: 'a', tool: 'bash', phase: 'called', at: 2 })
    applyStreamEvent(b, { type: 'tool', agentId: 'a', tool: 'bash', phase: 'success', at: 3 })
    assert.equal(tl(b, 'a')[1]?.phase, 'success')
    assert.equal(tl(b, 'a')[0]?.phase, 'called')
  })
  test('clearBucket 快照收口；未知 id 清除无操作', () => {
    const b = createLiveBuckets()
    applyStreamEvent(b, { type: 'stream', agentId: 'a1', event: { type: 'text-delta', text: 'x' } })
    clearBucket(b, 'a1')
    clearBucket(b, 'ghost')
    assert.equal(b['a1'], undefined)
  })
})

// ---------- 6. 思维链折叠 ----------

describe('reasoningView（running 追最新行 / 结束定格首行）', () => {
  test('空与纯空白 → null', () => {
    assert.equal(reasoningView('', true), null)
    assert.equal(reasoningView('  \n ', false), null)
  })
  test('running：折叠头 = 最后一个非空行；full = 原文自然序全文', () => {
    const v = reasoningView('第一行\n第二行\n最新半句', true)!
    assert.equal(v.summary, '最新半句')
    assert.equal(v.full, '第一行\n第二行\n最新半句')
  })
  test('完成：折叠头定格首行；展开态只渲染 full（两态互斥零重复）', () => {
    const v = reasoningView('第一行\n第二行', false)!
    assert.equal(v.summary, '第一行')
    assert.equal(v.full, '第一行\n第二行')
    assert.equal(reasoningView('只有一行', false)!.summary, '只有一行')
  })
})

// ---------- 7. 上下文占用 ----------

describe('contextRatio + ratioTone', () => {
  test('valid=false 归档行不计；封顶 1', () => {
    assert.equal(contextRatio([{ tokens: 1000 }, { tokens: 500, valid: false }], 2000), 0.5)
    assert.equal(contextRatio([{ tokens: 99999 }], 2000), 1)
  })
  test('窗口缺省兜底 1M；三色带边界 <0.2 ok / <0.4 warn / 其余 danger', () => {
    assert.equal(contextRatio([{ tokens: 12800 }], undefined), 12800 / 1_000_000)
    assert.equal(ratioTone(0.19), 'ok')
    assert.equal(ratioTone(0.2), 'warn')
    assert.equal(ratioTone(0.39), 'warn')
    assert.equal(ratioTone(0.4), 'danger')
    assert.equal(ratioTone(1), 'danger')
  })
})

// ---------- 8. 极简 markdown ----------

describe('mdToHtml（零依赖子集）', () => {
  test('XSS 构造安全：HTML 全转义、危险协议链接不物化', () => {
    const h = mdToHtml('<img src=x onerror=alert(1)> [点](javascript:alert(1))')
    assert.ok(!h.includes('<img'))
    assert.ok(h.includes('&lt;img'))
    assert.ok(!/<a[^>]*href=[^>]*javascript:/i.test(h)) // 危险协议不物化为 href（文本残留无害）
    assert.ok(!/<a\s/.test(h))
  })
  test('围栏代码块：语言标忽略、内部不解析 markdown、未闭合容错（流式）', () => {
    const h = mdToHtml('```ts\nconst a = "**不是粗体**"\n```')
    assert.ok(h.includes('<pre><code>const a = &quot;**不是粗体**&quot;</code></pre>'))
    assert.ok(!h.includes('<b>'))
    const unclosed = mdToHtml('先看看\n```python\nprint(1)')
    assert.ok(unclosed.includes('<pre><code>print(1)')) // 未闭合 = 到文末，流式不闪裸星号
  })
  test('行内码 + 粗斜体 + 链接（协议白名单）', () => {
    assert.ok(mdToHtml('用 `npm test` 跑').includes('<code>npm test</code>'))
    assert.ok(mdToHtml('**粗** 与 ***混***').includes('<b>粗</b>'))
    assert.ok(mdToHtml('**粗** 与 ***混***').includes('<b><i>混</i></b>'))
    assert.ok(mdToHtml('[stem](https://example.com)').includes('<a href="https://example.com" target="_blank" rel="noopener">stem</a>'))
    assert.equal(mdToHtml('a *b* 与 *c*'), '<p>a <i>b</i> 与 *c*</p>') // 单星保守只换行内第一处（防乘法噪音）
  })
  test('结构件：标题/列表/引用/hr/表格', () => {
    assert.ok(mdToHtml('## 标题').includes('<h2>标题</h2>'))
    assert.ok(mdToHtml('- 一\n- 二').includes('<ul><li>一</li><li>二</li></ul>'.replace(/><li>/g, '>\n<li>')) || mdToHtml('- 一\n- 二').includes('<li>二</li>'))
    assert.ok(mdToHtml('1. 一\n2. 二').includes('<ol>'))
    assert.ok(mdToHtml('> 引用').includes('<blockquote>引用</blockquote>'))
    assert.ok(mdToHtml('---').includes('<hr/>'))
    const t = mdToHtml('| a | b |\n|---|---|\n| 1 | 2 |')
    assert.ok(t.includes('<th>a</th>') && t.includes('<td>1</td>') && !t.includes('---'))
  })
  test('段落：空行分块、单换行 <br/>', () => {
    const h = mdToHtml('第一行\n第二行\n\n新段')
    assert.ok(h.includes('第一行<br/>第二行'))
    assert.equal((h.match(/<p>/g) ?? []).length, 2)
  })
})

// ---------- 9. 出生路径 id 自然序 ----------

describe('idOrder + 族谱显式排序', () => {
  test('逐段数值比较（字符串序的 0-10 < 0-2 陷阱被修正）', () => {
    assert.ok(idOrder('0-2', '0-10') < 0)
    assert.ok(idOrder('0-1-9', '0-2') < 0)
    assert.equal(idOrder('0-3', '0-3'), 0)
    assert.ok(idOrder('0', '0-1') < 0)
  })
  test('computeTreeRows：输入乱序子代仍按 id 自然序出栈', () => {
    const rows = computeTreeRows([
      { id: '0', parentId: null },
      { id: '0-10', parentId: '0' },
      { id: '0-2', parentId: '0' },
      { id: '0-1', parentId: '0' },
    ])
    assert.deepEqual(rows.filter(isNode).map((r) => r.id), ['0', '0-1', '0-2', '0-10'])
  })
})

// ---------- 10. 二级操作菜单 / 信息卡 / 相对时间 / 轮统计 ----------

describe('menuItems（数据驱动，无 agent 特判）', () => {
  test('根：对话 ready、监督 off、无中断/压缩项、毁 off', () => {
    const keys = menuItems({ id: '0', parentId: null }).map((i) => i.key)
    assert.ok(!keys.includes('interrupt') && !keys.includes('compact'))
    const items = menuItems({ id: '0', parentId: null })
    assert.equal(items.find((i) => i.key === 'watch')?.state, 'off')
    assert.equal(items.find((i) => i.key === 'terminate')?.state, 'off')
  })
  test('普通 agent：对话 active（当前视角语义）、毁 ready、label 全汉字', () => {
    const items = menuItems({ id: '0-1', parentId: '0' })
    assert.equal(items.find((i) => i.key === 'open')?.state, 'active')
    assert.equal(items.find((i) => i.key === 'terminate')?.state, 'ready')
    for (const i of items) assert.ok([...i.label].every((c) => /^[\u4e00-\u9fff]$/.test(c)), i.label)
  })
})

describe('relativeTime', () => {
  const now = 1_000_000_000_000
  test('档位：刚刚/秒前/分前/时前/天前；无值 = —', () => {
    assert.equal(relativeTime(0, now), '—')
    assert.equal(relativeTime(now - 1000, now), '刚刚')
    assert.equal(relativeTime(now - 30_000, now), '30 秒前')
    assert.equal(relativeTime(now - 120_000, now), '2 分前')
    assert.equal(relativeTime(now - 7_200_000, now), '2 时前')
    assert.equal(relativeTime(now - 172_800_000, now), '2 天前')
  })
})

describe('infoRows', () => {
  test('全名 = name#id；缺字段降级；模型行带来源标签', () => {
    const rows = infoRows({ id: '0-1', name: 'helper', parentId: '0', classRef: 'assistant', status: 'idle', model: 'p/m', modelOrigin: 'class' }, Date.now())
    assert.equal(rows.find((r) => r.k === '全名')?.v, 'helper#0-1')
    assert.equal(rows.find((r) => r.k === '策略')?.v, '—')
    assert.equal(rows.find((r) => r.k === '模型')?.v, 'p/m（类基因）')
    assert.ok(!rows.some((r) => r.k === '累计费')) // 终身 token 替代费用口径
    assert.equal(rows.find((r) => r.k === '累计')?.v, '0 tokens')
    assert.equal(infoRows(null).length, 0)
  })
  test('composerMeta：六项横排（全名/模型/策略/轮次/上下文/累计）', () => {
    const rows = composerMeta({ id: '0-1', name: 'h', parentId: '0', strategy: 'classic', turnCount: 3, ctxTokens: 1200, totalTokens: 8900, model: 'p/m' })
    assert.deepEqual(rows.map((r) => r.k), ['agent', '模型', '策略', '轮次', '上下文', '累计'])
    assert.equal(rows[0]?.v, 'h#0-1')
    assert.equal(rows[4]?.v, '1,200')
    assert.equal(rows[5]?.v, '8,900')
    assert.deepEqual(composerMeta(null), [])
  })
})

describe('toolFold（工具结果默认折叠件数据）', () => {
  test('头 = 首行截断；meta = 字数与行数；空白 = null', () => {
    const t = toolFold('total 100\ndrwxr-xr-x 2 node node 4096 Sep 10 .\n\nsecond')!
    assert.ok(t.head.startsWith('total 100'))
    assert.ok(t.meta.includes('行'))
    assert.equal(t.full, 'total 100\ndrwxr-xr-x 2 node node 4096 Sep 10 .\n\nsecond')
    assert.equal(toolFold('  '), null)
  })
})

describe('turnStats', () => {
  test('valid 行计数与 token 合计；最近一轮耗时 = 末 user → 末行', () => {
    const st = turnStats([
      { role: 'user', at: 1000, tokens: 10, turn: 1 },
      { role: 'assistant', at: 3500, tokens: 20, turn: 1 },
      { role: 'user', at: 5000, tokens: 5, turn: 2 },
      { role: 'assistant', at: 6000, tokens: 15, turn: 2 },
      { role: 'assistant', at: 99000, tokens: 1, turn: 9, valid: false },
    ])
    assert.equal(st.tokens, 50)
    assert.equal(st.turns, 2)
    assert.equal(st.durationS, 1)
  })
  test('空输入零值', () => {
    assert.deepEqual(turnStats([]), { tokens: 0, turns: 0, durationS: 0, firstAt: 0, lastAt: 0 })
  })
})
