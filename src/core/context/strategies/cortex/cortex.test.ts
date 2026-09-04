// ============================================================
// core/context/strategies/cortex/cortex.test.ts —— cortex 记忆策略
//
// 纯逻辑组：基因解析（clamp/warn）、LTM/笔记校验、目录渲染、
// 记忆组推导（水位线/作废面/实时选集）、轮替事务形状、工具暂存分流。
// 集成组（kernelHarness + FakeGateway + 内存 fs）：手动 dream 端到端
// （worker 配对→双 set→轮替→镜像→回收→下轮组装带组）、半途不轮替、
// 阈值自动点火、权限隔离（set 对宿主 deny / note 白拿 / worker 侧兑现）。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeGateway, textEvents } from '../../../gateway'
import type { LLMEvent, LLMRequest } from '../../../gateway'
import type { ChatMessage } from '../../../gateway'
import { BUILTIN_TEMPLATES, USER_ID } from '../../../kernel'
import { makeAgentClassID, makeAgentID } from '../../../kernel/types'
import type { AgentClass } from '../../../kernel/types'
import type { ContextStrategyModule, StrategyApi } from '../types'
import { DEFAULT_CONTEXT_SETTINGS } from '../types'
import { createBuiltinStrategyRegistry } from '../index'
import { DefaultToolCapabilityRegistry } from '../../../tools'
import type { StoredMessage } from '../../types'
import { createKernelHarness } from '../../../../../test/support/kernelHarness'
import { createCortexStrategy } from './cortex'
import { parseCortexSettings, validateLtm, validateNoteName, renderToc, firstLineSummary, renderLtm, DEFAULT_DREAM_AT } from './schema'
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
    assert.equal(parseCortexSettings(undefined, 600_000).dreamAt, DEFAULT_DREAM_AT)
    assert.equal(parseCortexSettings({ cortex: { dreamAt: 5000 } }, 600_000).dreamAt, 5000)
    const warns: string[] = []
    assert.equal(parseCortexSettings({ cortex: { dreamAt: 999_999 } }, 10_000, (m) => warns.push(m)).dreamAt, 9000)
    assert.equal(warns.length, 1)
    const w2: string[] = []
    assert.equal(parseCortexSettings({ cortex: { dreamAt: -1 } }, 600_000, (m) => w2.push(m)).dreamAt, DEFAULT_DREAM_AT)
    assert.equal(w2.length, 1)
    assert.deepEqual(parseCortexSettings({ cortex: { consolidateModel: { provider: 'p', id: 'q' } } }, 600_000).consolidateModel, { provider: 'p', id: 'q' })
    const w3: string[] = []
    assert.equal(parseCortexSettings({ cortex: { consolidateModel: 'bad' } }, 600_000, (m) => w3.push(m)).consolidateModel, undefined)
    assert.equal(w3.length, 1)
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

// ---------- 纯逻辑：工具暂存分流 ----------

describe('cortex 工具面：暂存与直写分流', () => {
  const LTM = { items: [{ text: 'a', source: 't1' }] }

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

  test('set 工具无梦拒收；有梦暂存；drain 合并释放全局锁', async () => {
    const { runtime, tools } = makeTools()
    const setLtm = toolOf(tools, 'cortex_set_ltm')
    const setStm = toolOf(tools, 'cortex_set_stm')
    const r0 = await setLtm.execute(LTM, { agentId: 'w1', spaceId: '/p' })
    assert.match(r0.text, /没有进行中/)
    runtime.begin('h1')
    const r1 = await setLtm.execute(LTM, { agentId: 'w1', spaceId: '/p' })
    assert.match(r1.text, /已暂存/)
    const r2 = await setStm.execute({ state: 'stm 正文' }, { agentId: 'w1', spaceId: '/p' })
    assert.match(r2.text, /收口/)
    const drained = runtime.drain()
    assert.equal(drained.ltm?.length, 1)
    assert.equal(drained.stm, 'stm 正文')
    assert.equal(runtime.dream, undefined, 'drain 释放全局锁')
  })

  test('note 工具：无梦直写 caller 目录；有梦 worker 暂存；host 自己直写', async () => {
    const { runtime, saverCalls, tools } = makeTools()
    const addNote = toolOf(tools, 'cortex_add_note')
    const delNote = toolOf(tools, 'cortex_del_note')
    await addNote.execute({ name: 'x-y', content: '正文' }, { agentId: 'agent1', spaceId: '/p' })
    assert.deepEqual(saverCalls, ['add:agent1/x-y'], '平时无梦 = agent 直写自己目录')
    runtime.begin('host1')
    await addNote.execute({ name: 'w-note', content: '梦笔记' }, { agentId: 'worker9', spaceId: '/p' })
    await delNote.execute({ name: 'old' }, { agentId: 'host1', spaceId: '/p' })
    assert.deepEqual(saverCalls, ['add:agent1/x-y', 'del:host1/old'], 'worker 不落盘（暂存）；host 梦中也直写')
    const drained = runtime.drain()
    assert.deepEqual(drained.notes.map((n) => `${n.op}:${n.name}`), ['add:w-note'])
  })

  test('validate 通道：LTM/笔记参数错误文本回模型', () => {
    const { tools } = makeTools()
    assert.match(toolOf(tools, 'cortex_set_ltm').validate?.({ items: [{ text: 'a' }] }) ?? '', /source/)
    assert.match(toolOf(tools, 'cortex_add_note').validate?.({ name: 'Bad Name', content: 'c' }) ?? '', /匹配/)
  })
})

// ---------- 集成：端到端做梦 ----------

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

// tools 刻意不设（继承形）：显式空表 = 本地封闭并锁子孙——会把
// dream worker 的 grant 键压成 deny（祖先显式判定锁树，权限语义正确；
// 本模板示范"正常宿主形态"）。
const cortexTemplate: AgentClass = {
  name: makeAgentClassID('mem-agent'),
  description: '挂 cortex 策略的测试 agent',
  systemPrompt: 'mem agent base',
  contextStrategy: 'cortex',
  custom: { cortex: { dreamAt: 300 } },
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
    return textEvents('普通回复')
  })
  const cortex: ContextStrategyModule = createCortexStrategy()
  const registry = createBuiltinStrategyRegistry([cortex])
  const fs = fakeFs()
  const settings = { ...DEFAULT_CONTEXT_SETTINGS, window: 100_000 }
  const staged = new DefaultToolCapabilityRegistry()
  await cortex.init?.({
    projectRoot: '/space',
    fs: fs.api,
    settings,
    log: { log: () => {} },
    registerTool: async (t) => {
      await staged.register(t, { replace: true })
    },
  })
  const h = await createKernelHarness(gateway, {
    templates: [...BUILTIN_TEMPLATES, cortexTemplate],
    strategies: registry,
    contextSettings: settings,
  })
  for (const t of await staged.list()) {
    await h.tools.register(t, { replace: true })
  }
  const agentId = await h.kernel.instantiateAgent(
    { className: makeAgentClassID('mem-agent'), parentId: makeAgentID(USER_ID), userPrompt: '开工写 cortex 测试' },
    '/space',
  )
  await h.deliveries.next()
  h.timers.flushAll()
  await pump(6)
  return { ...h, fs, requests, agentId }
}

const SET_LTM_EVENT: LLMEvent = {
  type: 'tool-call',
  id: 'c1',
  name: 'cortex_set_ltm',
  input: { items: [{ text: '用户要求：报告用中文（长期偏好）', source: 't1 用户要求' }] },
}
const SET_STM_EVENT: LLMEvent = {
  type: 'tool-call',
  id: 'c2',
  name: 'cortex_set_stm',
  input: { state: '# 当前状态\n\n在写 cortex 测试。' },
}

const fullDream = (turn: number): LLMEvent[] =>
  turn === 0
    ? [SET_LTM_EVENT, SET_STM_EVENT, { type: 'finish', reason: 'tool_calls' }]
    : textEvents('梦毕：两层记忆已重写。')

const ltmOnlyDream = (turn: number): LLMEvent[] =>
  turn === 0 ? [SET_LTM_EVENT, { type: 'finish', reason: 'tool_calls' }] : textEvents('自以为done的梦毕')

describe('cortex 端到端：做梦事务（手动 dream 触发）', () => {
  test('双 set 齐备 → 轮替 + 镜像 + worker 回收 + 下轮组装带组', async () => {
    const h = await cortexHarness(fullDream)
    const reports: string[] = []
    h.kernel.contextManager.runStrategyAction(h.agentId, 'dream').then((r) => reports.push(r), () => reports.push('FAILED'))
    for (let i = 0; i < 40 && reports.length === 0; i++) {
      h.timers.flushAll()
      await pump(3)
    }
    assert.match(reports.join('|'), /梦成/, `dream 回报应为轮替成功，实得：${reports.join('|')}`)

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
    const aliveWorkers = (await h.kernel.instances.listAll()).filter((i) => i.classRef === makeAgentClassID('cortex-dream'))
    assert.equal(aliveWorkers.length, 0, 'dream worker 一拍一生死（已回收）')

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

  test('半途而废（只 set_ltm）：不轮替、水位不动、锁释放可再梦', async () => {
    const h = await cortexHarness(ltmOnlyDream)
    const reports: string[] = []
    h.kernel.contextManager.runStrategyAction(h.agentId, 'dream').then((r) => reports.push(r), () => reports.push('FAILED'))
    for (let i = 0; i < 40 && reports.length === 0; i++) {
      h.timers.flushAll()
      await pump(3)
    }
    assert.match(reports.join('|'), /梦未完成/, `半途应有半途回报：${reports.join('|')}`)
    const state = await h.kernel.contextManager.getState(h.agentId)
    assert.ok(!state.messages.some((m) => m.tag === 'ltm'), '半途无 LTM 行（不轮替）')
    assert.equal(state.messages.find((m) => String(m.message.content).includes('开工写'))?.valid, true, '实时轮未归档（水位不动）')
    const second: string[] = []
    h.kernel.contextManager.runStrategyAction(h.agentId, 'dream').then((r) => second.push(r), () => second.push('FAILED'))
    for (let i = 0; i < 40 && second.length === 0; i++) {
      h.timers.flushAll()
      await pump(3)
    }
    assert.match(second.join('|'), /梦未完成/, '全局锁已释放（第二次同样半途而非拒于在途）')
  })

  test('阈值自动点火：过线送信后背景做梦自然轮替', async () => {
    const h = await cortexHarness(fullDream)
    await h.kernel.sendUserMessage(h.agentId, 'x'.repeat(2000))
    await pump(10)
    h.timers.flushAll()
    await pump(15)
    h.timers.flushAll()
    await pump(15)
    const state = await h.kernel.contextManager.getState(h.agentId)
    assert.ok(state.messages.some((m) => m.tag === 'ltm' && m.valid), 'process 点火自动做梦（异步不拦信，后台完成轮替）')
  })

  test('权限隔离：set 对宿主 deny、note 对宿主 allow（根表白拿）、worker grant 由梦成侧证', async () => {
    const h = await cortexHarness(fullDream)
    assert.equal(h.kernel.lineage.effectiveAccess(h.agentId, 'cortex_set_ltm'), 'deny', '根表不列 = 全树匿名 deny')
    assert.equal(h.kernel.lineage.effectiveAccess(h.agentId, 'cortex_set_stm'), 'deny')
    assert.equal(h.kernel.lineage.effectiveAccess(h.agentId, 'cortex_add_note'), 'allow', 'note 面继承形白拿')
  })

  test('agent 直写笔记落盘（非 cortex 类 agent 也可用，目录按 caller 建）', async () => {
    const h = await cortexHarness(fullDream)
    const addNote = (await h.tools.list()).find((t) => t.id === 'cortex_add_note')
    assert.ok(addNote)
    const res = await addNote.execute({ name: 'scratch-note', content: '灵感正文' }, { agentId: h.agentId, spaceId: '/space' })
    assert.match(res.text, /落盘/)
    assert.equal(h.fs.files.get(`${MEM_ROOT}/${h.agentId}/scratch-note.md`), '灵感正文')
  })
})
