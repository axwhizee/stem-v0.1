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
import type { TreeRow } from './view.js'

type NodeRow = Extract<TreeRow, { type: 'node' }>
const isNode = (r: TreeRow): r is NodeRow => r.type === 'node'

import {
  ACT_GLYPH,
  ROOT_ID,
  STATUS_GLYPH,
  computeTreeRows,
  deriveActions,
  routeLetters,
  statusGlyph,
  statusTone,
  stripSender,
  truncate,
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
    assert.equal(items[2]?.side, 'them')
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
