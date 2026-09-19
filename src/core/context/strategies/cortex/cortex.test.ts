// ============================================================
// core/context/strategies/cortex/cortex.test.ts —— cortex 记忆策略
//
// 纯逻辑组：基因解析（clamp/warn）、LTM/笔记校验、**dreamer 回信 schema
// 解析**、目录渲染、记忆组推导（水位线/作废面/实时选集）、轮替事务形状、
// 笔记归属路由（dreamer → host 目录）。
// 集成组（kernelHarness + FakeGateway + 内存 fs）：手动 dream 端到端
// （回信即交付物：spawn→schema 过→轮替→镜像→回收→下轮组装带组）、
// 纠错回信循环（坏→纠错→好）、纠错耗尽 = 半途不轮替、阈值自动点火、
// 权限声明清单 raise（宿主自动持有 / 非 cortex 不白拿 / set_* 灭迹）。
// 假策略审计组：策略 = 纯既有接口组合的定律链（ignore 注册声明 → 声明清单
// 抬 allow → 类/祖先显式更严 = 实例化拒绝——矛盾复用收敛检查零特判）。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeGateway, textEvents } from '../../../gateway'
import type { LLMEvent, LLMRequest } from '../../../gateway'
import type { ChatMessage } from '../../../gateway'
import { BUILTIN_TEMPLATES, ROOT_ID } from '../../../kernel'
import { makeAgentClassID, makeAgentID } from '../../../kernel/types'
import type { AgentClass } from '../../../kernel/types'
import type { ContextStrategyModule, StrategyApi } from '../types'
import { DEFAULT_CONTEXT_SETTINGS } from '../types'
import { classicAssemble } from '../classic'
import { createBuiltinStrategyRegistry } from '../index'
import { createKernelHarness } from '../../../../../test/support/kernelHarness'
import type { ToolCapability } from '../../../tools'
import type { StoredMessage } from '../../types'
import { createCortexStrategy } from './cortex'
import { resolveDreamAt, validateLtm, validateNoteName, renderToc, firstLineSummary, renderLtm, parseDreamReport, DEFAULT_DREAM_AT } from './schema'
import type { LtmItem } from './schema'
import { currentGroup, takeSnapshot, rotateGroup, ANCHOR_TEXT } from './memory'
import { CortexRuntime } from './state'
import { createCortexTools } from './tools'
import type { NoteSaver } from './tools'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function pump(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await tick()
  }
}

// ---------- 纯逻辑：schema ----------

describe('cortex schema：基因解析与校验', () => {
  test('缺省/覆盖/clamp 三态', () => {
    assert.equal(resolveDreamAt(undefined, 600_000), DEFAULT_DREAM_AT)
    assert.equal(resolveDreamAt(5000, 600_000), 5000)
    const warns: string[] = []
    assert.equal(resolveDreamAt(999_999, 10_000, (m) => warns.push(m)), 9000)
    assert.equal(warns.length, 1)
    const w2: string[] = []
    assert.equal(resolveDreamAt(-1, 600_000, (m) => w2.push(m)), DEFAULT_DREAM_AT)
    assert.equal(w2.length, 1)
  })

  test('validateLtm：provenance 铁律与上限', () => {
    const ok: LtmItem[] = [{ text: '用户偏好中文注释', source: 't3 用户明说' }]
    assert.equal(validateLtm(ok), undefined)
    assert.match(validateLtm([{ text: 'x' }]) ?? '', /source/)
    assert.match(validateLtm('nope') ?? '', /数组/)
    assert.match(validateLtm(Array.from({ length: 61 }, () => ok[0])) ?? '', /超上限/)
    assert.match(validateLtm([{ text: '长'.repeat(601), source: 's' }]) ?? '', /超 600/)
  })

  test('validateNoteName：规则与保留字', () => {
    assert.equal(validateNoteName('api-conventions'), undefined)
    assert.match(validateNoteName('Memory') ?? '', /匹配/)
    assert.match(validateNoteName('memory') ?? '', /保留字/)
    assert.match(validateNoteName('-x') ?? '', /匹配/)
  })

  test('目录渲染与首句摘要', () => {
    assert.match(renderToc([]), /尚无笔记/)
    assert.equal(renderToc([{ name: 'b', summary: 'S2' }, { name: 'a', summary: 'S1' }]), 'a —— S1\nb —— S2')
    assert.equal(firstLineSummary('# 标题\n\n正文首句。'), '标题')
    assert.equal(firstLineSummary('短行'), '短行')
    assert.equal(firstLineSummary('   \n  '), '(空)')
  })

  test('parseDreamReport：回信 schema（双段齐 + JSON 严核 + 废话/围栏宽容）', () => {
    const good = '<cortex_dream>\n<ltm>\n[{"text":"偏好中文","source":"t2 用户要求"}]\n</ltm>\n<stm># 状态\n\n在写测试。</stm>\n</cortex_dream>'
    const parsed = parseDreamReport(good)
    assert.ok(!('error' in parsed))
    assert.equal(parsed.ltm.length, 1)
    assert.equal(parsed.stm, '# 状态\n\n在写测试。')
    // 外围废话与 ltm 代码围栏宽容。
    assert.ok(!('error' in parseDreamReport(`整理完毕，报告如下：\n${'```json'}\n<cortex_dream><ltm>\n[{"text":"a","source":"b"}]\n</ltm><stm>x</stm></cortex_dream>`)))
    assert.match((parseDreamReport('自由发挥的梦话') as { error: string }).error, /cortex_dream/)
    assert.match((parseDreamReport('<cortex_dream><stm>x</stm></cortex_dream>') as { error: string }).error, /ltm/)
    assert.match((parseDreamReport('<cortex_dream><ltm>[{bad</ltm><stm>x</stm></cortex_dream>') as { error: string }).error, /JSON/)
    assert.match((parseDreamReport('<cortex_dream><ltm>[{"text":"a"}]</ltm><stm>x</stm></cortex_dream>') as { error: string }).error, /source/)
    assert.match((parseDreamReport('<cortex_dream><ltm>[]</ltm><stm>   </stm></cortex_dream>') as { error: string }).error, /stm.*空|空/)
  })
})

// ---------- 纯逻辑：记忆组推导与轮替 ----------

function stored(id: string, turn: number, role: ChatMessage['role'], content: string, tag?: string): StoredMessage {
  return { id, agentId: 'h1', message: { role, content }, at: 0, tokens: Math.ceil(content.length / 4), valid: true, ...(tag !== undefined ? { tag } : {}), turn, indexInTurn: 0 }
}

interface FakeApiBox {
  readonly api: StrategyApi
  readonly messages: StoredMessage[]
}

function fakeApi(initial: StoredMessage[]): FakeApiBox {
  const messages = [...initial]
  let seq = 100
  const api: StrategyApi = {
    agentId: 'h1',
    settings: DEFAULT_CONTEXT_SETTINGS,
    estimatedTokens: () => messages.filter((m) => m.valid).reduce((s, m) => s + m.tokens, 0),
    list: () => [...messages],
    listValid: () => messages.filter((m) => m.valid),
    append: async (message, tag) => {
      messages.push({ id: `x${String(seq++)}`, agentId: 'h1', message, at: 0, tokens: 10, valid: true, ...(tag !== undefined ? { tag } : {}), turn: 99, indexInTurn: 0 })
    },
    markInvalid: async (ids) => {
      for (const m of messages) {
        if (ids.includes(m.id)) (m as { valid: boolean }).valid = false
      }
    },
    spawn: async () => '',
    log: () => {},
  }
  return { api, messages }
}

describe('cortex 记忆组：推导与轮替事务', () => {
  test('无记忆组：watermark=0，全部非系统行都是实时段', () => {
    const rows = [stored('s', 0, 'system', 'sys'), stored('u', 1, 'user', 'hi'), stored('a', 1, 'assistant', 'yo')]
    const g = currentGroup(rows)
    assert.equal(g.watermark, 0)
    assert.equal(g.replaceableIds.length, 0)
    const { liveRows } = takeSnapshot(fakeApi(rows).api)
    assert.deepEqual(liveRows.map((r) => r.id), ['u', 'a'])
  })

  test('有记忆组：锚点保活、四行可换、组内行不入实时段、水位后新行入', () => {
    const group: StoredMessage[] = [
      stored('anchor', 10, 'user', ANCHOR_TEXT, 'cortex'),
      { ...stored('carrier', 10, 'assistant', '载入', 'cortex'), message: { role: 'assistant', content: '载入', toolCalls: [] } },
      stored('ltm', 10, 'tool', '[]', 'ltm'),
      stored('note', 10, 'tool', '目录', 'note'),
      stored('stm', 10, 'tool', '状态', 'stm'),
    ]
    const rows = [
      stored('s', 0, 'system', 'sys'),
      ...group,
      stored('old', 5, 'user', '水位前的旧轮'),
      stored('u2', 12, 'user', '梦后的新信'),
    ]
    const box = fakeApi(rows)
    const { group: g, liveRows } = takeSnapshot(box.api)
    assert.equal(g.watermark, 10)
    assert.deepEqual([...g.replaceableIds].sort(), ['carrier', 'ltm', 'note', 'stm'])
    assert.deepEqual(liveRows.map((r) => r.id), ['u2'], '锚点组行不入实时段；水位前旧行不重复入')
  })

  test('rotateGroup：首组补锚、载体三配对待写、旧组+实时作废、锚点永不重发', async () => {
    const box = fakeApi([
      stored('s', 0, 'system', 'sys'),
      stored('u1', 1, 'user', '工作一'),
      stored('u2', 2, 'user', '工作二'),
    ])
    const snap = takeSnapshot(box.api)
    const ltm: LtmItem[] = [{ text: '偏好', source: 't1' }]
    const invalidCount = await rotateGroup(box.api, snap, ltm, '# STM 状态', 'a —— 首句', renderLtm(ltm))
    assert.equal(invalidCount, 2)
    const appended = box.messages.filter((m) => m.turn === 99)
    assert.equal(appended.length, 5, '锚点+载体+三 tool 行')
    assert.equal(appended[0]?.tag, 'cortex')
    assert.equal(appended[0]?.message.role, 'user')
    const carrier = appended[1]
    assert.ok(carrier?.message.toolCalls && carrier.message.toolCalls.length === 3)
    const callIds = carrier.message.toolCalls.map((c) => c.name)
    assert.deepEqual(callIds, ['cortex_load_ltm', 'cortex_load_notes', 'cortex_load_stm'])
    assert.deepEqual(appended.slice(2, 5).map((m) => m.tag), ['ltm', 'note', 'stm'])
    assert.deepEqual(
      appended.slice(2, 5).map((m) => m.message.toolCallId),
      carrier.message.toolCalls.map((c) => c.id),
      'tool 行与载体调用逐一配对（legalize 前提）',
    )
    // 二次轮替：锚点不重写，旧组四行作废。
    const snap2 = takeSnapshot(box.api)
    assert.equal(snap2.group.anchor !== undefined, true)
    await rotateGroup(box.api, snap2, ltm, 'STM2', 'TOC2', renderLtm(ltm))
    const anchors = box.messages.filter((m) => m.tag === 'cortex' && m.message.role === 'user')
    assert.equal(anchors.length, 1, '锚点只有一份（不轮替）')
    const live = box.messages.filter((m) => m.valid)
    assert.equal(live.filter((m) => m.tag === 'ltm').length, 1, '记忆组只保留最新一份有效')
  })
})

// ---------- 纯逻辑：笔记归属路由（暂存机制退役后 = 立即落盘 + 计数） ----------

describe('cortex 工具面：笔记归属路由与落账', () => {
  function makeTools(): { runtime: CortexRuntime; saverCalls: string[]; tools: ReturnType<typeof createCortexTools> } {
    const runtime = new CortexRuntime()
    const saverCalls: string[] = []
    const saver: NoteSaver = {
      add: async (id, name) => { saverCalls.push(`add:${id}/${name}`) },
      del: async (id, name) => { saverCalls.push(`del:${id}/${name}`) },
    }
    return { runtime, saverCalls, tools: createCortexTools(runtime, saver) }
  }

  function toolOf(tools: ReturnType<typeof createCortexTools>, id: string) {
    const t = tools.find((x) => x.id === id)
    assert.ok(t)
    return t
  }

  test('工具面 = 笔记两枚（set_* 与暂存整体退役）', () => {
    const { tools } = makeTools()
    assert.deepEqual(tools.map((t) => t.id).sort(), ['cortex_add_note', 'cortex_del_note'])
    assert.deepEqual(tools.map((t) => t.registerAccess).sort(), ['ignore', 'ignore'], '策略注册工具出生恒 ignore')
  })

  test('note 工具：无梦直写 caller 目录；有梦 worker 以 host 名义立即落盘并计数', async () => {
    const { runtime, saverCalls, tools } = makeTools()
    const addNote = toolOf(tools, 'cortex_add_note')
    const delNote = toolOf(tools, 'cortex_del_note')
    await addNote.execute({ name: 'x-y', content: '正文' }, { agentId: 'agent1' })
    assert.deepEqual(saverCalls, ['add:agent1/x-y'], '平时无梦 = agent 直写自己目录')
    const token = runtime.begin('host1')
    await addNote.execute({ name: 'w-note', content: '梦笔记' }, { agentId: 'worker9' })
    await delNote.execute({ name: 'old' }, { agentId: 'host1' })
    assert.deepEqual(saverCalls, ['add:agent1/x-y', 'add:host1/w-note', 'del:host1/old'], 'worker 当场以 host 名义落盘；host 自己落自己')
    assert.equal(token.notesTouched, 1, 'worker 触碰计数入账（host 自己不计）')
    assert.equal(runtime.end(), 1, 'end 结出计数')
    assert.equal(runtime.dream, undefined, 'end 释放全局锁')
  })

  test('validate 通道：笔记参数错误文本回模型', () => {
    const { tools } = makeTools()
    assert.match(toolOf(tools, 'cortex_add_note').validate?.({ name: 'Bad Name', content: 'c' }) ?? '', /匹配/)
    assert.match(toolOf(tools, 'cortex_del_note').validate?.({}) ?? '', /name/)
  })
})

// ---------- 集成：端到端做梦（回信即交付物） ----------

interface FakeFs {
  readonly files: Map<string, string>
  readonly api: {
    listFiles: (d: string) => Promise<readonly string[]>
    readText: (f: string) => Promise<string>
    writeText: (f: string, c: string) => Promise<void>
    ensureDir: (d: string) => Promise<void>
  }
}

function fakeFs(): FakeFs {
  const files = new Map<string, string>()
  return {
    files,
    api: {
      listFiles: async (dir) =>
        [...files.keys()]
          .filter((f) => f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes('/'))
          .map((f) => f.slice(dir.length + 1)),
      readText: async (file) => {
        const v = files.get(file)
        if (v === undefined) throw new Error(`ENOENT ${file}`)
        return v
      },
      writeText: async (file, content) => {
        files.set(file, content)
      },
      ensureDir: async () => {},
    },
  }
}

const MEM_ROOT = '/space/.stem/mem'

/** 合格梦报告（回信文本 = 交付物——替代旧双 set 工具调用）。 */
const report = (stmBody = '# 当前状态\n\n在写 cortex 测试。'): LLMEvent[] =>
  textEvents(`<cortex_dream>\n<ltm>\n[{"text": "用户要求：报告用中文（长期偏好）", "source": "t1 用户要求"}]\n</ltm>\n<stm>${stmBody}</stm>\n</cortex_dream>`)

const BAD_REPORT: LLMEvent[] = textEvents('我把记忆想了一遍，感觉都挺牢的，不用写报告了。')

// tools 刻意不设（继承形）：显式空表 = 本地封闭并锁子孙——会把
// dreamer 的 grant 笔记键压成 deny（策略 raise 只作用于宿主，role 面板
// 是 none 策略无 raise 步）。本模板示范"正常宿主形态"。
const cortexTemplate: AgentClass = {
  name: makeAgentClassID('mem-agent'),
  description: '挂 cortex 策略的测试 agent',
  systemPrompt: 'mem agent base',
  contextStrategy: 'cortex',
}

/** 建挂 cortex 的 harness：策略经 init 注入工具（内存 fs），模板 custom 定线。 */
async function cortexHarness(workerTurns: (turn: number) => LLMEvent[]) {
  const requests: LLMRequest[] = []
  let dreamTurns = 0
  const gateway = new FakeGateway((request) => {
    requests.push(request)
    if (String(request.system).includes('宿主 agent 的睡眠整理过程')) {
      return workerTurns(dreamTurns++)
    }
    // usage 随请求体量（cortex 水位 = ctxTokens 反馈账；固定 0 会永不点火）。
    const inputTokens = Math.max(20, Math.ceil(
      request.messages.reduce((s, m) => s + String(m.content ?? '').length, 0) / 4,
    ))
    return textEvents('普通回复', { inputTokens, outputTokens: 8 })
  })
  const cortex: ContextStrategyModule = createCortexStrategy()
  const registry = createBuiltinStrategyRegistry([cortex])
  const fs = fakeFs()
  const settings = { ...DEFAULT_CONTEXT_SETTINGS, window: 100_000 }
  const owned =
    cortex.createOwnedTools?.({ projectRoot: '/space', fs: fs.api, settings }) ??
    cortex.ownedTools ??
    []
  const h = await createKernelHarness(gateway, {
    templates: [...BUILTIN_TEMPLATES, cortexTemplate],
    strategies: registry,
    contextSettings: settings,
    extraTools: owned,
  })
  const agentId = await h.kernel.instantiateAgent(
    { className: makeAgentClassID('mem-agent'), parentId: makeAgentID(ROOT_ID), userPrompt: '开工写 cortex 测试' },
  )
  await h.deliveries.next()
  h.timers.flushAll()
  await pump(6)
  return { ...h, fs, requests, agentId }
}

/**
 * 等 dream 收口。时序纪律（§6.3 陷阱的计时器面）：FakeGateway 轮 = 纯
 * microtask 链、不经计时器，而 mock flushAll 会把 60s 回信超时一并炸掉——
 * 先只泵 microtask，真卡住（等 courier 倒计时）才 flush。
 */
async function awaitReport(h: { timers: { flushAll: () => void } }, action: () => Promise<string>): Promise<string> {
  let reportText = ''
  action().then((r) => { reportText = r }, () => { reportText = 'FAILED' })
  for (let i = 0; i < 200 && reportText === ''; i++) {
    await pump(3)
    if (reportText === '' && i % 20 === 19) h.timers.flushAll()
  }
  return reportText
}

describe('cortex 端到端：做梦事务（回信即交付物）', () => {
  test('合格回信 → 轮替 + 镜像 + dreamer 回收 + 下轮组装带组', async () => {
    const h = await cortexHarness(() => report())
    const r = await awaitReport(h, () => h.kernel.contextManager.runStrategyAction(h.agentId, 'dream'))
    assert.match(r, /梦成/, `dream 回报应为轮替成功，实得：${r}`)

    const state = await h.kernel.contextManager.getState(h.agentId)
    const valid = state.messages.filter((m) => m.valid)
    assert.ok(valid.some((m) => m.tag === 'cortex' && m.message.role === 'user' && String(m.message.content).includes('stem_cortex')), '锚点在位')
    assert.ok(valid.some((m) => m.tag === 'cortex' && m.message.role === 'assistant' && m.message.toolCalls?.length === 3), '载体三虚拟调用在位')
    assert.ok(valid.some((m) => m.tag === 'ltm' && String(m.message.content).includes('长期偏好')), 'LTM 行在位')
    assert.ok(valid.some((m) => m.tag === 'stm' && String(m.message.content).includes('cortex 测试')), 'STM 行在位')
    assert.ok(valid.some((m) => m.tag === 'note'), '目录行在位')
    assert.equal(state.messages.find((m) => String(m.message.content).includes('开工写'))?.valid, false, '梦前实时轮归档')

    assert.ok(h.fs.files.get(`${MEM_ROOT}/${h.agentId}/.memory.json`)?.includes('长期偏好'), '镜像落盘')

    const role = h.kernel.lineage
      .getChildren(h.agentId)
      .map((id) => h.kernel.instances.getSync(id))
      .find((c) => c?.classRef === makeAgentClassID('strategy-cortex'))
    assert.ok(role, 'strategy-cortex 面板挂宿主下')
    const aliveWorkers = (await h.kernel.instances.listAll()).filter((i) => i.classRef === makeAgentClassID('cortex-dreamer'))
    assert.equal(aliveWorkers.length, 0, 'dreamer 一拍一生死（已回收）')

    const dreamed = h.kernel.logger.query({ type: 'context.dreamed' }).filter((e) => e.type === 'context.dreamed')
    assert.ok(dreamed.some((e) => e.consolidated), 'context.dreamed consolidated=true 入账')

    // 下轮送信：锚点与记忆组在场、归档轮消失。
    h.requests.length = 0
    await h.kernel.sendUserMessage(h.agentId, '继续干活')
    await pump(6)
    h.timers.flushAll()
    await pump(6)
    const last = h.requests.at(-1)
    assert.ok(last, '新请求已发出')
    assert.ok(
      last.messages.some((m) => typeof m.content === 'string' && m.content.includes('stem_cortex')),
      '锚点进入送信（教学样板在场）',
    )
    assert.ok(!last.messages.some((m) => typeof m.content === 'string' && m.content.includes('开工写')), '归档实时轮不再进上下文')
  })

  test('纠错回信循环：坏报告 → 策略错误信 → 同一 dreamer 修正 → 轮替落定', async () => {
    let seen = 0
    const h = await cortexHarness((turn) => (turn === 0 ? BAD_REPORT : report()))
    const r = await awaitReport(h, () => h.kernel.contextManager.runStrategyAction(h.agentId, 'dream'))
    assert.match(r, /梦成/, `纠错后应落定：${r}`)
    seen = 2
    // dreamer 生命周期内 = 两件（首件 + 纠错回信），纠错信由 role 名义发出。
    const workerRequests = h.requests.filter((req) => String(req.system).includes('宿主 agent 的睡眠整理过程'))
    assert.equal(workerRequests.length, 2, '一次纠错循环')
    assert.equal(seen, 2)
    assert.ok(
      workerRequests[1]?.messages.some((m) => typeof m.content === 'string' && m.content.includes('不合格')),
      '第二件携带纠错信（role→dreamer 生命周期内对话）',
    )
  })

  test('纠错轮耗尽 = 半途：不轮替、水位不动、锁释放可再梦', async () => {
    const h = await cortexHarness(() => BAD_REPORT)
    const r = await awaitReport(h, () => h.kernel.contextManager.runStrategyAction(h.agentId, 'dream'))
    assert.match(r, /梦未完成/, `半途应有半途回报：${r}`)
    const state = await h.kernel.contextManager.getState(h.agentId)
    assert.ok(!state.messages.some((m) => m.tag === 'ltm'), '半途无 LTM 行（不轮替）')
    assert.equal(state.messages.find((m) => String(m.message.content).includes('开工写'))?.valid, true, '实时轮未归档（水位不动）')
    // 第二次梦同样可达半途收口（锁已释放而非拒于在途）。
    h.requests.length = 0
    const r2 = await awaitReport(h, () => h.kernel.contextManager.runStrategyAction(h.agentId, 'dream'))
    assert.match(r2, /梦未完成/, '全局锁已释放（第二次同样半途而非拒于在途）')
    const workerRequests = h.requests.filter((req) => String(req.system).includes('宿主 agent 的睡眠整理过程'))
    assert.equal(workerRequests.length, 3, '每场梦 = 首件 + 2 轮纠错上限')
  })

  test('dreamer 笔记 grant 兑现：梦中 add_note 以 host 名义当场落盘并计入事件账', async () => {
    const noteCall: LLMEvent = { type: 'tool-call', id: 'n1', name: 'cortex_add_note', input: { name: 'dream-insight', content: '梦里沉淀的做法' } }
    const h = await cortexHarness((turn) =>
      turn === 0 ? [noteCall, { type: 'finish', reason: 'tool_calls' }] : report(),
    )
    const r = await awaitReport(h, () => h.kernel.contextManager.runStrategyAction(h.agentId, 'dream'))
    assert.match(r, /梦成/, r)
    assert.equal(h.fs.files.get(`${MEM_ROOT}/${h.agentId}/dream-insight.md`), '梦里沉淀的做法', '笔记落 host 目录')
    const dreamed = h.kernel.logger.query({ type: 'context.dreamed' }).filter((e) => e.type === 'context.dreamed')
    assert.ok(dreamed.some((e) => e.consolidated && e.notesTouched === 1), '笔记触碰计数进事件账')
  })

  test('阈值自动点火：ctxTokens 过线后下一封信触发背景做梦', async () => {
    const h = await cortexHarness(() => report())
    // 首信把 ctxTokens 顶过 dreamAt（window 100k → 300）；process 看的是上一轮反馈账。
    await h.kernel.sendUserMessage(h.agentId, 'x'.repeat(2000))
    await pump(10)
    h.timers.flushAll()
    await pump(15)
    h.timers.flushAll()
    await pump(15)
    // 第二封信抵达 → process 读到过线 ctxTokens → 后台点火。
    await h.kernel.sendUserMessage(h.agentId, '继续')
    await pump(10)
    h.timers.flushAll()
    await pump(15)
    h.timers.flushAll()
    await pump(15)
    const state = await h.kernel.contextManager.getState(h.agentId)
    assert.ok(state.messages.some((m) => m.tag === 'ltm' && m.valid), 'process 点火自动做梦（异步不拦信，后台完成轮替）')
  })

  test('权限声明清单 raise：宿主自动持有笔记面；set_* 灭迹；非 cortex 宿主不白拿', async () => {
    const h = await cortexHarness(() => report())
    assert.equal(h.kernel.lineage.effectiveAccess(h.agentId, 'cortex_add_note'), 'allow', '策略声明清单抬上台面')
    assert.equal(h.kernel.lineage.effectiveAccess(h.agentId, 'cortex_del_note'), 'allow')
    assert.notEqual(h.kernel.lineage.effectiveAccess(h.agentId, 'cortex_set_ltm'), 'allow', '工具已退役 = 永不上台面')
    assert.notEqual(h.kernel.lineage.effectiveAccess(h.agentId, 'cortex_set_stm'), 'allow')
    // 非 cortex 宿主（经典策略、根表不含笔记键）：拿不到。
    const plainId = await h.kernel.instantiateAgent(
      { className: makeAgentClassID('assistant'), parentId: makeAgentID(ROOT_ID), userPrompt: 'hi' },
    )
    assert.notEqual(h.kernel.lineage.effectiveAccess(plainId, 'cortex_add_note'), 'allow', '非 cortex 类不再白拿')
  })

  test('agent 直写笔记落盘（目录按 caller 建）', async () => {
    const h = await cortexHarness(() => report())
    const addNote = (await h.tools.list()).find((t) => t.id === 'cortex_add_note')
    assert.ok(addNote)
    const res = await addNote.execute({ name: 'scratch-note', content: '灵感正文' }, { agentId: h.agentId })
    assert.match(res.text, /落盘/)
    assert.equal(h.fs.files.get(`${MEM_ROOT}/${h.agentId}/scratch-note.md`), '灵感正文')
  })
})

// ---------- 假策略审计：策略 = 纯既有接口组合的定律链 ----------

const FAKE_TOOL: ToolCapability = {
  id: 'fake_note',
  kind: 'custom',
  registerAccess: 'ignore', // 策略注册通例
  description: '假策略自带工具（审计用）',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ text: 'ok' }),
}

const fakeStrategy: ContextStrategyModule = {
  name: 'fake',
  assemble: classicAssemble,
  tools: { fake_note: 'allow' }, // 声明清单（raise 步）
  ownedTools: [FAKE_TOOL],
}

function fakeTemplate(tools?: AgentClass['tools']): AgentClass {
  return {
    name: makeAgentClassID(tools === undefined ? 'fake-agent' : 'fake-agent-locked'),
    description: '挂假策略的审计 agent',
    systemPrompt: 'fake base',
    contextStrategy: 'fake',
    ...(tools !== undefined ? { tools } : {}),
  }
}

async function fakeHarness(userClass?: ConstructorParameters<typeof import('../../../kernel').Kernel>[0]['userClass'], extraTemplates: readonly AgentClass[] = [fakeTemplate()]) {
  const gateway = new FakeGateway(() => textEvents('ok'))
  const h = await createKernelHarness(gateway, {
    templates: [...BUILTIN_TEMPLATES, ...extraTemplates],
    strategies: createBuiltinStrategyRegistry([fakeStrategy]),
    ...(userClass !== undefined ? { userClass } : {}),
    extraTools: fakeStrategy.ownedTools ?? [],
  })
  return h
}

describe('策略声明清单审计（定律：ignore 注册声明 → raise 抬升 → 矛盾拒绝）', () => {
  test('正常宿主：类未列笔记键，声明清单使生效面 = allow', async () => {
    const h = await fakeHarness()
    const id = await h.kernel.instantiateAgent(
      { className: makeAgentClassID('fake-agent'), parentId: makeAgentID(ROOT_ID), userPrompt: 'hi' },
    )
    assert.equal(h.kernel.lineage.effectiveAccess(id, 'fake_note'), 'allow')
  })

  test('矛盾拒绝：类显式 deny 同键 → 实例化被拒（复用收敛检查，零特判）', async () => {
    const locked = fakeTemplate({ fake_note: 'deny' })
    const h = await fakeHarness(undefined, [locked])
    await assert.rejects(
      () => h.kernel.instantiateAgent(
        { className: makeAgentClassID('fake-agent-locked'), parentId: makeAgentID(ROOT_ID), userPrompt: 'hi' },
      ),
      (cause: unknown) => {
        const err = cause as { kind: string; violations: string[] }
        assert.equal(err.kind, 'tools_convergence_expanded')
        assert.ok(err.violations.some((v) => v.includes('策略收敛') && v.includes('fake_note')), `归因到策略层：${err.violations.join('|')}`)
        return true
      },
    )
  })

  test('祖先封顶：根对键显式 deny → 宿主 raise 被拒（写面拒绝归因策略层）', async () => {
    const h = await fakeHarness({ tools: { fake_note: 'deny' } } as never)
    await assert.rejects(
      () => h.kernel.instantiateAgent(
        { className: makeAgentClassID('fake-agent'), parentId: makeAgentID(ROOT_ID), userPrompt: 'hi' },
      ),
      (cause: unknown) => {
        const err = cause as { kind: string; violations: string[] }
        assert.equal(err.kind, 'tools_convergence_expanded')
        assert.ok(err.violations.some((v) => v.includes('fake_note')))
        return true
      },
    )
  })

  test('纯 raise 链不破继承形封闭（父白名单封闭 → 宿主未列键仍 deny）', async () => {
    // 根写白名单表（未列 bash）→ 根 fallback deny 下传；
    // fake-agent 类不设表 + raise fake_note → 表外键仍继承根封闭。
    const h = await fakeHarness({ tools: { pin: 'allow' } } as never)
    const id = await h.kernel.instantiateAgent(
      { className: makeAgentClassID('fake-agent'), parentId: makeAgentID(ROOT_ID), userPrompt: 'hi' },
    )
    assert.equal(h.kernel.lineage.effectiveAccess(id, 'fake_note'), 'allow', 'raise 键在封闭父面下照常抬升（封顶=出生∧父显式，父未列=不锁）')
    assert.equal(h.kernel.lineage.effectiveAccess(id, 'bash'), 'deny', '表外键继承根的本地封闭')
  })
})
