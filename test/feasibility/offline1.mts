// ============================================================
// test/feasibility/offline1.mts —— 机制可行性离线冒烟档 1
//
// v1.0 初步测试（验收方案的机制可行性子集，零密钥零成本）：
//   S1 装配全链 / S2 端到端消息+token 真实计量 / S3 ask 审批（消息化）
//   + 进化书写落盘 / S4 多 agent 实例化与通信 / S5 模型四级律+热切+不级联
//   / S6 SQLite 持久化+重启恢复+再工作。
// LLM = mockSse 匿名 provider（R13 形态）——走真实宿主装配路径（bootStem），
// 只替网关。运行：npm run test:feas（node >= 23.4，tsx）。
// 非 node:test 单元（跨模块全链路冒烟，独立退出码）。
// ============================================================
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { startMockSse } = await import('../../shell/cli/mockSse.ts')
const { bootStem } = await import('../../shell/cli/platform.ts')
const { makeAgentClassID, makeAgentID } = await import('../../src/core/kernel')
const { defaultStemConfig } = await import('../../src/core/config')

let pass = 0
let fail = 0
const ok = (name: string, cond: unknown, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`) }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------- mock 网关脚本（OpenAI chunk 形状） ----------
const textResp = (text: string) => ({
  kind: 'stream' as const,
  chunks: [
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 220, completion_tokens: 15 } },
  ],
})
const toolCallResp = (name: string, args: Record<string, unknown>) => ({
  kind: 'stream' as const,
  chunks: [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 240, completion_tokens: 25 } },
  ],
})
const script = (body: Record<string, unknown>) => {
  const msgs = (body.messages ?? []) as Array<{ role: string; content: unknown }>
  const last = msgs[msgs.length - 1]
  const text = last?.role === 'user' && typeof last.content === 'string' ? last.content : ''
  if (text.includes('WRITE_CLASS')) {
    // 子实例（writer 类，agent_class_create=ask）申请书写类 → 触发 ask 消息化。
    return toolCallResp('agent_class_create', {
      name: 'reviewer', description: '审查员类', systemPrompt: 'You review things.',
      tools: { read: 'allow' }, model: 'mock/genomic',
    })
  }
  if (text.includes('USE_BASH')) {
    // coder 子实例被收敛 bash=ask → 触发根信箱审批链。
    return toolCallResp('bash', { command: 'echo feasibility-bash-ok' })
  }
  return textResp(`MOCK-DONE[${String(body.model)}]: ${text.slice(0, 40)}`)
}

// ---------- 空间自举（mock 端口先起，配置指向它） ----------
const mock = await startMockSse({ script })
const dir = mkdtempSync(join(tmpdir(), 'stem-feas-'))
mkdirSync(join(dir, '.stem'), { recursive: true })
writeFileSync(join(dir, '.stem', 'stem.jsonc'), JSON.stringify({
  providers: { mock: { base_url: mock.url } },
  user: { model: 'mock/echo', tools: defaultStemConfig().user?.tools },
  autoApprove: false,
  maxSteps: 6,
  context: { window: 128000, compact: { enabled: false } },
  extensions: { tools: {} },
  sendCountdown: 20,
}, null, 2))

const letters: Array<{ agentId: string; text: string }> = []
const statuses: Array<{ agentId: string; status: string }> = []

async function waitIdle(label: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  let quiet = 0
  while (Date.now() - start < timeoutMs) {
    await sleep(40)
    if (sys.pilot.activeAgents().length === 0) { if (++quiet >= 5) return } else quiet = 0
  }
  throw new Error(`waitIdle 超时: ${label}（active=${JSON.stringify(sys.pilot.activeAgents())}）`)
}
async function waitLetter(marker: string, timeoutMs = 20_000): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const hit = letters.find((l) => l.text.includes(marker))
    if (hit) { const m = /<access_request id="([^"]+)"/.exec(hit.text); if (m) return m[1]! }
    await sleep(50)
  }
  throw new Error(`等 ${marker} 超时；letters=${JSON.stringify(letters.slice(-3))}`)
}

let boot = await bootStem({ projectRoot: dir })
let sys = boot.system
sys.pilot.subscribe((ev) => {
  if (ev.type === 'letter') for (const m of ev.letters) letters.push({ agentId: ev.agentId, text: String(m.content ?? '') })
  if (ev.type === 'status') statuses.push({ agentId: ev.agentId, status: ev.to })
})

try {
  // ---------- S1 装配与权限物化 ----------
  console.log('S1 装配（bootStem 全链）')
  const agents0 = await sys.pilot.listAgents()
  ok('根（user#0）存在且为根', agents0.some((a) => a.id === '0' && a.parentId === null && a.name === 'user'), JSON.stringify(agents0.map((a) => [a.id, a.parentId])))
  const toolsAll = await sys.tools.list()
  ok('internal 工具在场（bash/access_reply）', toolsAll.some((t) => t.id === 'bash') && toolsAll.some((t) => t.id === 'access_reply'))
  ok('extension 纯关（extensions.tools={} 不点名）', !toolsAll.some((t) => t.id === 'read'))
  const mat = sys.tools.materialize('0').map((d) => { const x = d as { name: string }; return x.name })
  ok('族谱物化根能力面', mat.includes('access_reply') && mat.includes('agent_class_create') && mat.includes('agent_update'), JSON.stringify(mat))

  // ---------- S2 端到端消息（pilot→子实例 → LLM 轮 → 回信信箱） ----------
  console.log('S2 端到端（根面板模型：发信给实例，实例跑轮，回信归位）')
  const reqsBefore = mock.requests.length
  await sys.pilot.sendMessage('0', 'PANEL-NO-TURN')
  await sleep(600)
  ok('根面板态：自消息不触发 LLM 轮（信件只落信箱）', mock.requests.length === reqsBefore)
  const coderId = await sys.pilot.instantiate({ className: makeAgentClassID('assistant'), userPrompt: 'HI coder', name: 'coder-1' }, dir)
  await waitIdle('S2')
  ok('LLM 轮真实发生（mock 收到请求）', mock.requests.length >= 1, JSON.stringify(mock.requests.map((r) => r.body?.model)))
  const corpus2 = await sys.pilot.exportContext(coderId)
  ok('coder 回载入库（user 信 + assistant 回）', corpus2.includes('HI coder') && corpus2.includes('MOCK-DONE'), corpus2.slice(0, 200))
  ok('assistant 行真实 output token（usage 直记 15）', /"tokens":\s*15/.test(corpus2), corpus2.slice(-300))
  ok('回信自动投递根信箱（letter 事件）', letters.some((l) => l.agentId === '0' && l.text.includes('MOCK-DONE')), JSON.stringify(letters.slice(-2)))
  ok('status 事件流有迁移', statuses.length > 0)
  const inst2 = await sys.pilot.inspect(coderId)
  ok('coder 出生（parentId=根 0）', inst2.parentId === makeAgentID('0'), JSON.stringify(inst2.parentId))

  // ---------- S3 ask 审批（消息化）+ 进化书写 + bash 对外操作面 ----------
  console.log('S3 子实例跑轮：ask→根信箱→答复→落盘；bash allow 执行')
  await sys.kernel.templates.register({
    name: makeAgentClassID('writer'), description: '书写试验类', systemPrompt: 'You write.',
    tools: { agent_class_create: 'ask', bash: 'allow' },
  })
  const writerId = await sys.pilot.instantiate({ className: makeAgentClassID('writer'), userPrompt: 'WRITE_CLASS 创建一个 reviewer 类', name: 'writer-1' }, dir)
  const reqId = await waitLetter('<access_request')
  ok('access_request 投递根信箱（ask 消息化，含 accessKey）',
     letters.some((l) => l.agentId === '0' && l.text.includes('accessKey="agent_class_create"')), JSON.stringify(letters.slice(-3)))
  await sys.pilot.replyAccess({ requestId: reqId, reply: 'once' })
  await waitIdle('S3-post-approval')
  ok('审批通过后类文件落盘 .stem/agent/reviewer.md', existsSync(join(dir, '.stem', 'agent', 'reviewer.md')))
  ok('reviewer 类注册进模板表', (await sys.kernel.templates.list()).some((c) => c.name === makeAgentClassID('reviewer')))
  // bash allow 直执行（无 ask）：结果作为 tool 行回载语料
  await sys.kernel.sendMessage('0', writerId, 'USE_BASH 执行 echo')
  await waitIdle('S3-bash')
  ok('bash allow 执行且结果入库（对外操作面）', (await sys.pilot.exportContext(writerId)).includes('feasibility-bash-ok'))

  // ---------- S4 agent 间通信 ----------
  console.log('S4 agent 间消息驱动新轮')
  await sys.kernel.sendMessage('0', coderId, 'INTER-MESSAGE-2')
  await waitIdle('S4-cross')
  ok('跨 agent 消息驱动 coder 新轮', (await sys.pilot.exportContext(coderId)).includes('INTER-MESSAGE-2'))

  // ---------- S5 模型四级律 ----------
  console.log('S5 模型解析（显式>类基因>父继承>家学 + 快照 + 不级联）')
  await sys.pilot.instantiate({ className: makeAgentClassID('reviewer'), userPrompt: 'hi', name: 'gene-1' }, dir)
  const geneModel = sys.kernel.lineage.modelOf(sys.kernel.resolveAgent('gene-1'))
  ok('类基因 origin=class', geneModel?.origin === 'class' && geneModel.ref.id === 'genomic', JSON.stringify(geneModel))
  const expId = await sys.pilot.instantiate({ className: makeAgentClassID('assistant'), userPrompt: 'hi', name: 'exp-1', model: { provider: 'mock', id: 'explicit' } }, dir)
  ok('出生显式 origin=explicit', sys.kernel.lineage.modelOf(expId)?.origin === 'explicit')
  const inhId = await sys.kernel.instantiateAgent({ className: makeAgentClassID('assistant'), parentId: coderId, userPrompt: 'hi', name: 'inh-1' }, dir)
  const inhModel = sys.kernel.lineage.modelOf(inhId)
  ok('家学下传保 origin=home（git-blame 语义，coder 无基因）', inhModel?.origin === 'home' && inhModel.ref.id === 'echo', JSON.stringify(inhModel))
  ok('根 origin=home', sys.kernel.lineage.modelOf('0')?.origin === 'home')
  await sys.pilot.setModel(coderId, { provider: 'mock', id: 'hot' })
  await sys.kernel.sendMessage('0', coderId, 'after set model')
  await waitIdle('S5-hot')
  ok('setModel 生效（下轮请求 model=mock/hot）', mock.requests.some((r) => r.body?.model === 'hot'), JSON.stringify(mock.requests.map((r) => r.body?.model)))
  ok('setModel 不级联（inh-1 仍 home echo 非 hot）', sys.kernel.lineage.modelOf(sys.kernel.resolveAgent('inh-1'))?.ref.id === 'echo')

  // ---------- S6 重启恢复 ----------
  console.log('S6 持久化 + 重启恢复')
  await sys.dispose()
  boot = await bootStem({ projectRoot: dir })
  sys = boot.system
  const agents6 = await sys.pilot.listAgents()
  ok('实例全集恢复（coder-1/gene-1/exp-1/inh-1）', ['coder-1', 'gene-1', 'exp-1', 'inh-1'].every((n) => agents6.some((a) => a.name === n)), JSON.stringify(agents6.map((a) => a.id)))
  ok('状态归一化（无 thinking/holding）', !agents6.some((a) => a.status === 'thinking' || a.status === 'holding'))
  ok('信箱语料跨重启（根面板信 + writer 首轮均在库）',
     (await sys.pilot.exportContext('0')).includes('PANEL-NO-TURN') && (await sys.pilot.exportContext(sys.kernel.resolveAgent('writer-1'))).includes('WRITE_CLASS'))
  ok('模型显式层跨重启（exp-1=explicit hot?→explicit）', sys.kernel.lineage.modelOf(sys.kernel.resolveAgent('exp-1'))?.origin === 'explicit')
  ok('coder setModel 快照跨重启（mock/hot）', sys.kernel.lineage.modelOf(sys.kernel.resolveAgent('coder-1'))?.ref.id === 'hot', JSON.stringify(sys.kernel.lineage.modelOf(sys.kernel.resolveAgent('coder-1'))))
  ok('reviewer 类跨重启（目录即真相）', (await sys.kernel.templates.list()).some((c) => c.name === 'reviewer'))
  // 重启后再走一轮端到端（恢复后系统可继续工作）
  await sys.pilot.sendMessage('0', 'RESUMED-CHECK')
  await waitIdle('S6-resume')
  ok('重启后新一轮正常', (await sys.pilot.exportContext('0')).includes('RESUMED-CHECK'))
} catch (e) {
  fail++
  console.log('  FAIL  未捕获异常：', e instanceof Error ? e.message : JSON.stringify(e))
} finally {
  await sys.dispose().catch(() => {})
  await mock.close()
  rmSync(dir, { recursive: true, force: true })
  console.log(`\n== 离线档1结果：PASS ${pass} / FAIL ${fail} ==`)
  process.exit(fail > 0 ? 1 : 0)
}
