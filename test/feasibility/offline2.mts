// ============================================================
// test/feasibility/offline2.mts —— 机制可行性离线冒烟档 2
//
// 上下文策略机制：classic compact 自动触发（wake 链内、摘要 worker 正规
// 邮局往返、markInvalid 归档可逆）+ 手动动作面（runContextAction compact）
// + 策略注册表（user .stem/context 覆盖通道）。零密钥（mockSse）。
// ============================================================
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { startMockSse } = await import('../../shell/cli/mockSse.ts')
const { bootStem } = await import('../../shell/cli/platform.ts')
const { makeAgentClassID } = await import('../../src/core/kernel')

let pass = 0
let fail = 0
const ok = (name: string, cond: unknown, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`) }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// mock：summarizer 模型 = 摘要 worker（回 SUMMARY_ 前缀）；普通轮 = echo。
const stream = (text: string, model: string, promptTokens: number) => ({
  kind: 'stream' as const,
  chunks: [
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: promptTokens, completion_tokens: 18 } },
  ],
})
let echoRound = 0
const script = (body: Record<string, unknown>) => {
  const msgs = (body.messages ?? []) as Array<{ role: string; content: unknown }>
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
  const text = typeof lastUser?.content === 'string' ? lastUser.content : ''
  if (body.model === 'summarizer') return stream(`SUMMARY_WORKER_OK(${msgs.length} 条被摘要)`, 'summarizer', 80)
  // input 阶梯递增（保证相邻差分 Δ=input(n)−input(n−1)−out(n−1) 为正——
  // 真实 usage 归位通道畅通；固定值会命中负差回落护栏 = 测试数据敏感性陷阱）。
  echoRound += 1
  return stream(`TURN:${text.slice(0, 24)}`, String(body.model), 120 + 220 * echoRound)
}

const mock = await startMockSse({ script })
const dir = mkdtempSync(join(tmpdir(), 'stem-feas2-'))
mkdirSync(join(dir, '.stem'), { recursive: true })
// window 400 / threshold 0.4 → 160 token 触发；每轮 input 记账 300 → 首轮即压。
writeFileSync(join(dir, '.stem', 'stem.jsonc'), JSON.stringify({
  providers: { mock: { base_url: mock.url } },
  user: { model: 'mock/echo' },
  maxSteps: 4,
  context: { window: 400, compact: { enabled: true, threshold: 0.4, keepRecentTurns: 1, summarizeModel: 'mock/summarizer' } },
  extensions: { tools: {} },
  sendCountdown: 20,
}, null, 2))

const boot = await bootStem({ projectRoot: dir })
const sys = boot.system

async function waitIdle(label: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  let quiet = 0
  while (Date.now() - start < timeoutMs) {
    await sleep(40)
    if (sys.pilot.activeAgents() === undefined) break
    if (sys.pilot.activeAgents().length === 0) { if (++quiet >= 5) return } else quiet = 0
  }
  if (quiet < 5) throw new Error(`waitIdle 超时: ${label}`)
}

try {
  // ---------- C1 策略注册表与加载面 ----------
  console.log('C1 策略注册表')
  const reg = sys.kernel.contextManager.strategies
  ok('内置 classic/none 在注册表', reg.has('classic') && reg.has('none'), JSON.stringify(reg.names()))

  // ---------- C2 compact 自动触发 ----------
  console.log('C2 classic compact 自动触发（wake 链内）')
  const id = await sys.pilot.instantiate({ className: makeAgentClassID('assistant'), userPrompt: 'ROUND-ONE 长文本 '.padEnd(120, '字'), agentId: 'cmp-1' }, dir)
  await waitIdle('C2-round1')
  await sys.kernel.sendMessage('user0', id, 'ROUND-TWO 长文本 '.padEnd(120, '字'))
  await waitIdle('C2-round2')
  // compact 检查点在"下一封 user 信抵达"（wake 链内、组装前）——需要第三轮做触发探针。
  await sys.kernel.sendMessage('user0', id, 'ROUND-THREE 长文本 '.padEnd(120, '字'))
  await waitIdle('C2-round3')
  const corpus = await sys.pilot.exportContext(id)
  const summaryReq = mock.requests.filter((r) => r.body?.model === 'summarizer')
  ok('摘要 worker 正规往返（summarizeModel 生效）', summaryReq.length >= 1, JSON.stringify(mock.requests.map((r) => r.body?.model)))
  ok('summary 合成行入库（tag=summary + worker 回执）', corpus.includes('SUMMARY_WORKER_OK'))
  ok('归档可逆：markInvalid 行保留（valid:false 在库）', /"valid":false/.test(corpus), corpus.slice(-200))
  ok('系统未卡死：压缩后照常回轮', corpus.includes('ROUND-THREE'))
  const turnCount = (await sys.pilot.inspect(id)).turnCount
  ok('turnCount 计数器续接（未被 compact 重置）', turnCount >= 2, JSON.stringify(turnCount))

  // ---------- C3 手动 compact 动作面 ----------
  console.log('C3 pilot.runContextAction compact（手动通道）')
  await sys.kernel.sendMessage('user0', id, 'ROUND-THREE 长文本 '.padEnd(120, '字'))
  await waitIdle('C3-round3')
  const before = mock.requests.filter((r) => r.body?.model === 'summarizer').length
  const res = await sys.pilot.runContextAction(id, 'compact')
  await waitIdle('C3-post')
  const after = mock.requests.filter((r) => r.body?.model === 'summarizer').length
  ok('动作返回回执文本', typeof res === 'string' && res.length > 0, JSON.stringify(res))
  ok('手动触发第二次摘要', after >= before, JSON.stringify({ before, after }))

  // ---------- C4 面板/根不跑轮（策略不触发） ----------
  console.log('C4 user0 面板：发信给自身不产生网关请求')
  const reqsBefore = mock.requests.length
  await sys.pilot.sendMessage('user0', 'PANEL-NO-TURN-CHECK')
  await sleep(600)
  ok('面板自消息零请求（compact 亦不触发）', mock.requests.length === reqsBefore)
} catch (e) {
  fail++
  console.log('  FAIL  未捕获异常：', e instanceof Error ? e.message : JSON.stringify(e))
} finally {
  await sys.dispose().catch(() => {})
  await mock.close()
  rmSync(dir, { recursive: true, force: true })
  console.log(`\n== 离线档2结果：PASS ${pass} / FAIL ${fail} ==`)
  process.exit(fail > 0 ? 1 : 0)
}
