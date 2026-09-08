// ============================================================
// test/feasibility/v10-live.mts —— v1.x 发布前实测在线档（真模型；验收现场 space-v12）
//
// 剧本 = docs/v10-test-plan.md（本轮聚焦可行性，场景 4 自进化不追）。
// 我以根（user#0 船长面板）第一视角经 pilot 编排：pilot.instantiate /
// sendMessage 驱动真模型，mailbox 监听 access_request 自动批 once。
//
// 每个场景独立进程（防互相拖累），**全局 watchdog 硬超时**（用户要求：
// 绝不卡死——到时写证据、打印进度、rc=3 退出）；空间 .stem 持久 = 天然
// 断点续跑（findOrCreate 复用实例）。
//
// 运行：OPENCODE_API_KEY=<key> npx tsx test/feasibility/v10-live.mts --scenario=N [--phase=P]
//   1 常驻助理（双轮+真重启+needle）      2 tester 修 bug（ask→批→绿）
//   3 族谱协作（wait 收卷 + 可见域墙）    5 cortex（phase=warm|probe|dream|pause）
// 退出码：0 全过 / 1 有 FAIL / 2 缺密钥跳过 / 3 watchdog 掐死。
// ============================================================

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'space-v12')
const ART = join(ROOT, '.artifacts')
mkdirSync(ART, { recursive: true })

const argOf = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const scenario = argOf('scenario') ?? '1'
const phase = argOf('phase') ?? ''

const { bootStem } = await import('../../shell/cli/platform.ts')
const { makeAgentClassID, ROOT_ID } = await import('../../src/core/kernel')
const { makeAgentID } = await import('../../src/core/kernel/types')
const { parseConfigText } = await import('../../src/core/config')
import type { Pilot } from '../../src/core/pilot'
import type { StemSystem } from '../../src/core/init'

if (!process.env.OPENCODE_API_KEY) {
  console.log('跳过：OPENCODE_API_KEY 未注入（在线档需真网关；注入法见 contributor §8）')
  process.exit(2)
}

let pass = 0
let fail = 0
const results: Array<{ name: string; ok: boolean; extra?: string }> = []
const ok = (name: string, cond: unknown, extra = '') => {
  const good = Boolean(cond)
  if (good) pass++
  else fail++
  results.push({ name, ok: good, ...(extra !== '' ? { extra: extra.slice(0, 400) } : {}) })
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${name}${good || extra === '' ? '' : `  ${extra.slice(0, 200)}`}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------- 证据与成本 ----------
let globalStage: Stage | undefined
function eventsDump(stage: Stage): Array<Record<string, unknown>> {
  // 全量直落（长场景先截断会把早期关键事件挤出——证据文件体积换完整性）。
  return stage.sys.kernel.logger
    .query({})
    .map((e) => ({ ...e } as unknown as Record<string, unknown>))
}

function dumpEvidence(tag: string, extra: Record<string, unknown> = {}): void {
  const file = join(ART, `s${scenario}${phase === '' ? '' : `-${phase}`}-${tag}.json`)
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), pass, fail, results, ...extra }, null, 2))
  console.log(`  [evidence] ${file}`)
}

// ---------- watchdog：绝不卡死（用户硬性要求） ----------
const BUDGET_MS: Record<string, number> = {
  '1': 8 * 60_000, '2': 8 * 60_000, '3': 6 * 60_000,
  '5-warm': 14 * 60_000, '5-probe': 12 * 60_000, '5-dream': 8 * 60_000, '5-pause': 6 * 60_000,
}
const budgetKey = `${scenario}${phase === '' ? '' : `-${phase}`}`
const budget = BUDGET_MS[budgetKey] ?? 8 * 60_000
const watchdog = setTimeout(() => {
  console.log(`\n  [watchdog] ${budgetKey} 超预算 ${String(budget / 60_000)} 分钟——掐死防卡（已完成断言见证据）`)
  dumpEvidence('timeout', globalStage ? { events: eventsDump(globalStage) } : {})
  process.exit(3)
}, budget)
watchdog.unref?.()

// ---------- 会话编排核心 ----------
interface Stage {
  sys: StemSystem
  letters: Array<{ agentId: string; text: string; at: number }>
  approved: string[]
}

async function boot(): Promise<Stage> {
  const boot_ = await bootStem({ projectRoot: ROOT })
  const sys = boot_.system
  const stage: Stage = { sys, letters: [], approved: [] }
  globalStage = stage
  sys.pilot.subscribe((ev) => {
    if (ev.type === 'letter') {
      for (const m of ev.letters) {
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        stage.letters.push({ agentId: ev.agentId, text, at: Date.now() })
        // 自动审批（我扮演船长）：验收策略白名单——改文件/写类放行 once；
        // terminate/类书写拒绝（保留工人与证据）；其余默认 once。
        for (const hit of text.matchAll(/<access_request id="([^"]+)" accessKey="([^"]+)"/g)) {
          const [id, key] = [hit[1]!, hit[2]!]
          console.log(`  [approval] 捕获申请 ${id} ${key} -> 裁决中`)
          const verdict: 'once' | 'reject' = /^(agent_terminate|agent_class_create|agent_class_update)$/.test(key) ? 'reject' : 'once'
          const promise = sys.pilot.replyAccess({ requestId: id, reply: verdict, ...(verdict === 'reject' ? { feedback: '验收期保留子 agent 与现场，不许销毁' } : {}) })
          void promise.then(
            () => { stage.approved.push(`${id}:${key}=${verdict}`) },
            (e: unknown) => { stage.approved.push(`${id}:${key}=ERR:${String((e as { kind?: string }).kind ?? e)}`) },
          )
        }
      }
    }
  })
  return stage
}

/** 等静默（activeAgents 清零连续 ~1s）+ 硬超时上限（默认 120s，用户要求 <1min 单请求，工具轮放宽）。 */
async function waitIdle(stage: Stage, capMs = 120_000): Promise<boolean> {
  const start = Date.now()
  let quiet = 0
  while (Date.now() - start < capMs) {
    await sleep(250)
    if (stage.sys.pilot.activeAgents().length === 0) {
      if (++quiet >= 4) return true
    } else quiet = 0
  }
  return false
}

/** 幂等复用/创建（DB 持久 = 断点续跑）。 */
async function findOrCreate(stage: Stage, className: string, userPrompt: string, name?: string): Promise<string> {
  const agents = await stage.sys.pilot.listAgents()
  const hit = agents.find((a) => a.classRef === makeAgentClassID(className) && a.status !== 'terminated')
  if (hit !== undefined) return hit.id
  return stage.sys.pilot.instantiate({ className: makeAgentClassID(className), userPrompt, ...(name !== undefined ? { name } : {}) })
}

/** 发给 agent 并等回信到达 根信箱（回复文本；超时返回 ''）。 */
/**
 * 发信并等"这一封信的回复"——以目标实例 turnCount 递增 + 全体静默为配对判据
 * （纯信件时间戳会被上一轮迟到回复污染，v1.0 实测抓获的编排竞态）。
 */
async function ask(stage: Stage, agentId: string, text: string, capMs = 120_000): Promise<string> {
  await waitIdle(stage, 30_000)
  const t0 = (await stage.sys.pilot.inspect(agentId)).turnCount
  const sentAt = Date.now()
  await stage.sys.pilot.sendMessage(agentId, text)
  const start = Date.now()
  let lastBeat = 0
  while (Date.now() - start < capMs) {
    await sleep(500)
    const inst = await stage.sys.pilot.inspect(agentId)
    if (Date.now() - lastBeat > 30_000) {
      lastBeat = Date.now()
      console.log(`  [ask] ${agentId} turn=${String(inst.turnCount)}/${String(t0)} ${inst.status} active=${String(stage.sys.pilot.activeAgents().length)} 审批=${String(stage.approved.length)}`)
    }
    if (inst.turnCount > t0 && stage.sys.pilot.activeAgents().length === 0) {
      // 本轮闭合：根信箱取发信后的最新一封（排除审批信）。
      const fresh = stage.letters.filter((l) => l.agentId === ROOT_ID && l.at >= sentAt && !l.text.includes('<access_request'))
      return fresh.length > 0 ? fresh.at(-1)!.text.replace(/<[^>]+>/g, '') : `(turn+1 但无回信文本，status=${inst.status})`
    }
  }
  return ''
}

function cost(stage: StemSystem | Stage): number {
  const sys = 'sys' in stage ? stage.sys : stage
  let sum = 0
  for (const e of sys.kernel.logger.query({ type: 'gateway.apiRequest' })) {
    if (e.type === 'gateway.apiRequest') sum += e.cost
  }
  return sum
}

// ---------- 场景剧本 ----------
async function scenario1(): Promise<void> {
  console.log('\n== 场景 1：常驻助理（双轮 + 真重启 + needle）==')
  let stage = await boot()
  const uid = await stage.sys.pilot.inspect(ROOT_ID)
  ok('S1 根 name 配置链 = 船长', uid.name === '船长', uid.name)
  const companion = await findOrCreate(stage, 'assistant', '记住这条事实：我每天早上喝气泡水加柠檬。回复"记下了"即可。')
  const r1 = await ask(stage, companion, '我每天早上喝什么？直接简短回答。')
  ok('S1 首轮对话回含 needle（气泡水）', r1.includes('气泡'), r1.slice(0, 120))
  await stage.sys.dispose()

  // —— 真重启：新进程新实例复用同一空间 ——
  stage = await boot()
  const r2 = await ask(stage, companion, '我每天早上喝什么？')
  ok('S1 重启后 needle 仍在（write-through 记忆）', r2.includes('气泡'), r2.slice(0, 120))
  const tele = stage.sys.kernel.logger.query({ agentId: makeAgentID(companion) })
  ok('S1 telemetry 可回放本轮活动', tele.length > 0, String(tele.length))
  dumpEvidence('done', { events: eventsDump(stage).filter((e) => String(e.type).startsWith('context.') || String(e.type) === 'kernel.orphan.error' || String(e.type) === 'access.asked'),  costUsd: cost(stage) })
  await stage.sys.dispose()
}

async function scenario2(): Promise<void> {
  console.log('\n== 场景 2：专职工人（organizer→tester 修 bug，edit ask→批→绿）==')
  const stage = await boot()
  const organizer = await findOrCreate(stage, 'organizer', '你好，等你指令（一句话确认即可）。')
  await waitIdle(stage, 90_000)
  const before = stage.approved.length
  const r = await ask(
    stage, organizer,
    '用 agent_instantiate 创建 tester（className=tester，wait=true），任务：cd 到 bug 目录，跑 python3 test_calc.py 会失败；读 calc.py 定位 area_of_circle 的 bug 并用 edit 修复；再跑到 ALL GREEN 后汇报修了什么。',
    420_000,
  )
  ok('S2 收卷含修复总结（非寒暄）', /修|area|半径|radius|green|绿/i.test(r), r.slice(0, 160))
  ok('S2 edit ask 门真实触发并经我批过', stage.approved.length > before, `approved=${String(stage.approved.length - before)}`)
  const src = readFileSync(join(ROOT, 'bug', 'calc.py'), 'utf-8')
  ok('S2 磁盘证据：bug 代码已被模型改掉', !src.includes('radius * 2'), src.slice(0, 150))
  const green = spawnSync('python3', ['test_calc.py'], { cwd: join(ROOT, 'bug'), encoding: 'utf-8' })
  ok('S2 测试真变绿', green.stdout.includes('ALL GREEN'), `${green.stdout}|${green.stderr}`.slice(0, 200))
  // 修好即复原（可重跑：git 管理下也可 checkout 复原）——复原留给用户/脚本外。
  dumpEvidence('done', { events: eventsDump(stage).filter((e) => String(e.type).startsWith('context.') || String(e.type) === 'kernel.orphan.error' || String(e.type) === 'access.asked'),  organizerReply: r.slice(0, 600), costUsd: cost(stage) })
  await stage.sys.dispose()
}

async function scenario3(): Promise<void> {
  console.log('\n== 场景 3：族谱协作（双 worker wait 收卷 + 可见域墙）==')
  const stage = await boot()
  const organizer = await findOrCreate(stage, 'organizer', '你好（一句话确认）。')
  await waitIdle(stage, 90_000)
  const r = await ask(
    stage, organizer,
    '依次创建两个 helper（className=helper，都 wait=true）：第一个任务「执行 hostname 并报输出」；第二个任务「执行 pwd 并报输出」。两个结果各一句话汇总给我。',
    300_000,
  )
  ok('S3 wait 双收卷有汇总', r.length > 0 && (r.includes('/') || r.length > 10), r.slice(0, 160))
  const state = await stage.sys.kernel.contextManager.getState(organizer)
  const toolRows = state.messages.filter((m) => m.message.role === 'tool' && m.valid && !m.tag)
  ok('S3 两次 wait 的 tool 结果行配对入库', toolRows.length >= 2, String(toolRows.length))
  // 部门墙：organizer 的孙（helper）看不到旁支树。取任意 helper 验证 canReach。
  const helpers = (await stage.sys.pilot.listAgents()).filter((a) => a.classRef === makeAgentClassID('helper'))
  const root = stage.sys.kernel.lineage.canReach(helpers[0]?.id ?? '', makeAgentID(ROOT_ID))
  ok('S3 墙机制在场（helper 不可达根）', helpers.length >= 2 ? root === false : true, `helpers=${String(helpers.length)}`)
  dumpEvidence('done', { events: eventsDump(stage).filter((e) => String(e.type).startsWith('context.') || String(e.type) === 'kernel.orphan.error' || String(e.type) === 'access.asked'),  organizerReply: r.slice(0, 600), costUsd: cost(stage) })
  await stage.sys.dispose()
}

async function scenario5(): Promise<void> {
  const stage = await boot()
  const pet = await findOrCreate(
    stage, 'cortex-pet',
    '记住这条事实并确认：我最爱吃蓝莓酱抹吐司（这是 needle）。今天先跑一轮：执行 hostname 报告结果。',
  )
  const dreamedCount = (): number =>
    stage.sys.kernel.logger.query({ type: 'context.dreamed' }).filter((e) => e.type === 'context.dreamed' && e.consolidated).length
  // 历史进程的梦不驻留本进程 logger——以仓库行为准。
  const memoryRows = async () => {
    const st = await stage.sys.kernel.contextManager.getState(pet)
    return {
      ltm: st.messages.filter((m) => m.tag === 'ltm' && m.valid).length,
      stm: st.messages.filter((m) => m.tag === 'stm' && m.valid).length,
      anchor: st.messages.some((m) => m.tag === 'cortex' && m.message.role === 'user'),
      needleValid: st.messages.some((m) => String(m.message.content).includes('蓝莓') && m.tag === undefined && m.valid && m.message.role === 'user'),
    }
  }
  if (phase === 'warm') {
    console.log('\n== 场景 5·warm：灌工作轮直至做梦（dreamAt=8000）==')
    let first = true
    for (let i = 0; i < 14; i++) {
      const reply = await ask(stage, pet, first ? '确认收到，跑第一轮。' : `第 ${String(i + 1)} 轮：执行 date +%s 报秒数，再讲一句与本轮无关的小知识。`, 120_000)
      if (reply === '') { ok('S5warm 轮中断（模型超时未回）', false, `round ${String(i)}`); break }
      first = false
      const rows = await memoryRows()
      if (rows.ltm > 0) { ok(`S5warm 第 ${String(i + 1)} 轮后已做梦（记忆组在场）`, true); break }
      if (i === 13) ok('S5warm 14 轮未触发梦', false, JSON.stringify(rows))
    }
    const rows = await memoryRows()
    ok('S5warm 记忆组三件套齐（ltm/stm/锚点）', rows.ltm > 0 && rows.stm > 0 && rows.anchor, JSON.stringify(rows))
    ok('S5warm 镜像 .memory.json 落盘', existsSync(join(ROOT, '.stem', 'mem', pet, '.memory.json')))
    dumpEvidence('done', { events: eventsDump(stage).filter((e) => String(e.type).startsWith('context.') || String(e.type) === 'kernel.orphan.error' || String(e.type) === 'access.asked'),  costUsd: cost(stage) })
  } else if (phase === 'probe') {
    console.log('\n== 场景 5·probe：催梦 → 梦后 needle 断言 ==')
    let rows = await memoryRows()
    if (rows.ltm === 0) {
      // 水位已过线（类文件 dreamAt=3500）——发一轮信触发背景做梦，等轮替落定。
      void ask(stage, pet, '随便一句话回答我：天空为什么是蓝的？', 120_000).catch(() => {})
      const start = Date.now()
      let beat = 0
      while (Date.now() - start < 8 * 60_000) {
        await sleep(3000)
        rows = await memoryRows()
        if (++beat % 10 === 0) console.log(`  [dream-poll] ${String(Math.round((Date.now() - start) / 1000))}s 记忆组=${JSON.stringify(rows)}`)
        if (rows.ltm > 0) break
      }
    }
    ok('S5probe 做梦已落定（记忆组三件套在场）', rows.ltm > 0 && rows.stm > 0 && rows.anchor, JSON.stringify(rows))
    rows = await memoryRows()
    ok('S5probe 早期 needle 实时轮已被归档（valid=false）', !rows.needleValid, JSON.stringify(rows))
    const t0 = Date.now()
    const answer = await ask(stage, pet, '我最爱吃什么？直接回答。', 120_000)
    ok('S5probe 核心：上下文无实时轮仍答对 needle（跨梦记忆）', answer.includes('蓝莓'), `${answer.slice(0, 150)}（${String(Date.now() - t0)}ms）`)
    const ltmRow = (await stage.sys.kernel.contextManager.getState(pet)).messages.find((m) => m.tag === 'ltm' && m.valid)
    const mirror = existsSync(join(ROOT, '.stem', 'mem', pet, '.memory.json'))
      ? readFileSync(join(ROOT, '.stem', 'mem', pet, '.memory.json'), 'utf-8')
      : ''
    ok('S5probe 镜像与 ltm 行一致', mirror !== '' && String(ltmRow?.message.content ?? '').slice(0, 60) === mirror.slice(0, 60))
    dumpEvidence('done', { events: eventsDump(stage).filter((e) => String(e.type).startsWith('context.') || String(e.type) === 'kernel.orphan.error' || String(e.type) === 'access.asked'),  answer: answer.slice(0, 400), rows, costUsd: cost(stage) })
  } else if (phase === 'dream') {
    console.log('\n== 场景 5·dream：模型自主做梦（context_apply dream）==')
    const rows0 = await memoryRows()
    const before = (await stage.sys.kernel.contextManager.getState(pet)).messages.filter((m) => m.tag === 'ltm').length
    const reply = await ask(stage, pet, '用 context_apply 手动做梦一次（action=dream），然后告诉我结果。', 300_000)
    const after = (await stage.sys.kernel.contextManager.getState(pet)).messages.filter((m) => m.tag === 'ltm').length
    ok('S5dream 模型自主调用做梦（轮替行增加）', after > before, `${reply.slice(0, 150)} before=${String(before)} after=${String(after)}`)
    ok('S5dream 做梦前记忆组在场（warm 生效）', rows0.ltm > 0)
    dumpEvidence('done', { events: eventsDump(stage).filter((e) => String(e.type).startsWith('context.') || String(e.type) === 'kernel.orphan.error' || String(e.type) === 'access.asked'),  reply: reply.slice(0, 400), costUsd: cost(stage) })
  } else if (phase === 'pause') {
    console.log('\n== 场景 5·pause：agent_pause 挂起攒信 ==')
    const before = Date.now()
    const pending = stage.sys.pilot.sendMessage(pet, '用 agent_pause 挂起 8000 毫秒。挂起结束后，告诉我你在暂停期间收到了什么新消息（如有），一句话。')
    void pending
    await sleep(3000)
    // 挂起中塞信（信件照常进信箱；唤醒可能提前=机制允许）。
    await stage.sys.pilot.sendMessage(pet, '暂停期间插一句：我后来改喝椰子水了，记住。')
    const settled = await waitIdle(stage, 240_000)
    const elapsed = Date.now() - before
    ok('S5pause 挂起后归位（无卡死）', settled, `elapsed=${String(Math.round(elapsed / 1000))}s`)
    const answer = await ask(stage, pet, '我上一条插话说了什么？', 90_000)
    ok('S5pause 攒信在场（答出椰子水）', answer.includes('椰子'), answer.slice(0, 150))
    dumpEvidence('done', { events: eventsDump(stage).filter((e) => String(e.type).startsWith('context.') || String(e.type) === 'kernel.orphan.error' || String(e.type) === 'access.asked'),  elapsedMs: elapsed, answer: answer.slice(0, 400), costUsd: cost(stage) })
  } else {
    console.log('scenario=5 需要 --phase=warm|probe|dream|pause')
    process.exit(1)
  }
  await stage.sys.dispose()
}

const run: Record<string, () => Promise<void>> = {
  '1': scenario1, '2': scenario2, '3': scenario3, '5': scenario5,
}
const fn = run[scenario]
if (fn === undefined) {
  console.log(`未知场景 ${scenario}（可选 1/2/3/5）`)
  process.exit(1)
}
console.log(`[v10-live] scenario=${scenario}${phase === '' ? '' : ` phase=${phase}`} budget=${String(Math.round(budget / 60_000))}min 空间=${ROOT}`)
try {
  await fn()
} catch (cause) {
  console.log(`  [crash] ${cause instanceof Error ? `${cause.message}\n${cause.stack ?? ''}` : JSON.stringify(cause)}`)
  fail++
  dumpEvidence('crash')
}
console.log(`\n[v10-live] scenario=${scenario} ${phase} 结果：PASS ${String(pass)} / FAIL ${String(fail)}`)
clearTimeout(watchdog)
process.exit(fail > 0 ? 1 : 0)
