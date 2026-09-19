// ============================================================
// test/feasibility/online.mts —— 机制可行性在线档（真网关 ALIBABA/qwen3.8-flash）
//
// 前置：ALIBABA_API_KEY 已注入环境（值只走 env，注入法见 docs/contributor.md §8）。
// 验证 mock 不可测面：W1 真 LLM 轮 / W2 真模型自发生成 tool_call→bash 执行
// 回注→闭合 / W3 真 websearch+webfetch（extension 装载+外网） /
// W4 真模型进化书写（allow 直写→类落盘） / W5 telemetry_query 观测 /
// W6 真 compact（小窗口真摘要）。运行：ALIBABA_API_KEY=<key> npx tsx test/feasibility/online.mts
// 成本控制：flash 模型 × 短 prompt × maxSteps 4，全程约 8~10 轮。
// ============================================================
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { bootStem } = await import('../../shell/cli/platform.ts')
const { makeAgentClassID } = await import('../../src/core/kernel')

let pass = 0
let fail = 0
const ok = (name: string, cond: unknown, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`) }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

if (!process.env.ALIBABA_API_KEY) {
  console.log('跳过：ALIBABA_API_KEY 未注入（在线档需要真网关）')
  process.exit(2)
}

const dir = mkdtempSync(join(tmpdir(), 'stem-on-'))
mkdirSync(join(dir, '.stem'), { recursive: true })
writeFileSync(join(dir, '.stem', 'stem.jsonc'), JSON.stringify({
  providers: { alibaba: { base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', key_env: 'ALIBABA_API_KEY' } },
  user: { model: 'alibaba/qwen3.8-flash' },
  context: { window: 4000, compact: { enabled: true, threshold: 0.5, keepRecentTurns: 1 } },
  extensions: { tools: { websearch: 'allow', webfetch: 'allow' } },
  sendCountdown: 20,
}, null, 2))

const letters: Array<{ agentId: string; text: string }> = []
const boot = await bootStem({ projectRoot: dir })
const sys = boot.system
sys.pilot.subscribe((ev) => {
  if (ev.type === 'letter') for (const m of ev.letters) letters.push({ agentId: ev.agentId, text: String(m.content ?? '') })
})

async function waitIdle(label: string, timeoutMs = 120_000): Promise<void> {
  const start = Date.now()
  let quiet = 0
  while (Date.now() - start < timeoutMs) {
    await sleep(200)
    if (sys.pilot.activeAgents().length === 0) { if (++quiet >= 4) return } else quiet = 0
  }
  throw new Error(`waitIdle 超时: ${label}（active=${JSON.stringify(sys.pilot.activeAgents())}）`)
}
async function waitLetter(marker: string, timeoutMs = 90_000): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const hit = letters.find((l) => l.text.includes(marker))
    if (hit) { const m = /<access_request id="([^"]+)"/.exec(hit.text); if (m) return m[1]! }
    await sleep(300)
  }
  throw new Error(`等 ${marker} 超时`)
}

try {
  // ---------- W1 真 LLM 轮 ----------
  console.log('W1 真网关端到端（coder 小任务）')
  const coderId = await sys.pilot.instantiate({ className: makeAgentClassID('assistant'), userPrompt: '只回答一个数字：2+3 等于几？不要调用任何工具。', name: 'on-coder' }, dir)
  await waitIdle('W1')
  const w1 = await sys.pilot.exportContext(coderId)
  ok('真 LLM 轮闭合且答案含 5', w1.includes('"assistant"') && /5/.test(w1), w1.slice(-300))
  ok('真实 usage 直记（tokens 非估算整数特征）', /"tokens":\s*[0-9]+/.test(w1))

  // ---------- W2 真工具循环（模型自发 bash） ----------
  console.log('W2 模型自主 tool_call → bash 执行 → 结果回注 → 闭合')
  await sys.kernel.templates.register({
    name: makeAgentClassID('operator'), description: '操作试验类', systemPrompt: '按指令使用工具，完成后用一句话总结。',
    tools: { bash: 'allow', agent_class_create: 'allow', websearch: 'allow', webfetch: 'allow', telemetry_query: 'allow' },
  })
  const opId = await sys.pilot.instantiate({ className: makeAgentClassID('operator'), userPrompt: '用 bash 执行 echo stem-online-ok，然后告诉我输出了什么。', name: 'on-op' }, dir)
  await waitIdle('W2')
  const w2 = await sys.pilot.exportContext(opId)
  ok('bash tool_call 真实发生（tool 结果行入库）', w2.includes('"role":"tool"') && w2.includes('stem-online-ok'), w2.slice(0, 400))

  // ---------- W3 真 websearch / webfetch ----------
  console.log('W3 extension 工具实弹（websearch + webfetch）')
  await sys.kernel.sendMessage('0', opId, '用 websearch 搜一下「西湖 在哪座城市」，只搜一次，告诉我城市名。')
  await waitIdle('W3-search')
  const w3 = await sys.pilot.exportContext(opId)
  const searchHit = /杭州/.test(w3) || /hangzhou/i.test(w3)
  ok('websearch 真实检索结果进入语料', searchHit, w3.slice(-500))
  await sys.kernel.sendMessage('0', opId, '用 webfetch 打开 https://example.com ，说出页面标题里的第一个英文单词。')
  await waitIdle('W3-fetch')
  const w3f = await sys.pilot.exportContext(opId)
  ok('webfetch 真实抓取（example 域正文特征）', /example/i.test(w3f) && w3f.length > w3.length, w3f.slice(-300))

  // ---------- W4 真模型进化书写（allow 直写） ----------
  console.log('W4 真模型 agent_class_create → 落盘')
  await sys.kernel.sendMessage('0', opId, '用 agent_class_create 创建一个类：name=online-reviewer，description=在线审查类，systemPrompt=You review。不要执行任何 shell 命令，只创建类。')
  await waitIdle('W4-write')
  ok('类文件真实落盘', existsSync(join(dir, '.stem', 'agent', 'online-reviewer.md')))

  // ---------- W5 telemetry 观测面 ----------
  console.log('W5 telemetry_query 模型侧观测')
  await sys.kernel.sendMessage('0', opId, '调用 telemetry_query 查询你自己的最近运行记录，回复"看到 N 条"即可，不要其他动作。')
  await waitIdle('W5')
  const w5 = await sys.pilot.exportContext(opId)
  ok('telemetry 查询轮闭合（含结果回注）', w5.length > 100 && /条|记录|telemetry|log/i.test(w5.slice(-800)), w5.slice(-300))

  // ---------- W6 真 compact ----------
  console.log('W6 真网关小窗口 compact')
  const wdir = mkdtempSync(join(tmpdir(), 'stem-on2-'))
  mkdirSync(join(wdir, '.stem'), { recursive: true })
  writeFileSync(join(wdir, '.stem', 'stem.jsonc'), JSON.stringify({
    providers: { alibaba: { base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', key_env: 'ALIBABA_API_KEY' } },
    user: { model: 'alibaba/qwen3.8-flash' },
    context: { window: 1500, compact: { enabled: true, threshold: 0.5, keepRecentTurns: 1 } },
    extensions: { tools: {} },
    sendCountdown: 20,
  }, null, 2))
  const boot2 = await bootStem({ projectRoot: wdir })
  const sys2 = boot2.system
  const waitIdle2 = async (label: string) => {
    const start = Date.now()
    let quiet = 0
    while (Date.now() - start < 120_000) {
      await sleep(200)
      if (sys2.pilot.activeAgents().length === 0) { if (++quiet >= 4) return } else quiet = 0
    }
    throw new Error(`waitIdle2 超时 ${label}`)
  }
  const cid = await sys2.pilot.instantiate({ className: makeAgentClassID('assistant'), userPrompt: '请用 200 字介绍光合作用。', name: 'on-compact' }, wdir)
  await waitIdle2('W6-a')
  await sys2.kernel.sendMessage('0', cid, '很好，再用 200 字介绍呼吸作用。')
  await waitIdle2('W6-b')
  await sys2.kernel.sendMessage('0', cid, '最后用 50 字总结上面两个概念的关系。')
  await waitIdle2('W6-c')
  const w6 = await sys2.pilot.exportContext(cid)
  ok('真实 compact 触发（summary 合成行入库）', /"tag":"summary"/.test(w6), w6.slice(-400))
  ok('归档行保留（valid:false 可逆）', /"valid":false/.test(w6))
  ok('压缩后对话仍闭合', w6.includes('关系') || w6.includes('总结'))
  await sys2.dispose()
  rmSync(wdir, { recursive: true, force: true })
} catch (e) {
  fail++
  console.log('  FAIL  未捕获异常：', e instanceof Error ? e.message : JSON.stringify(e))
} finally {
  await sys.dispose().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
  console.log(`\n== 在线档结果：PASS ${pass} / FAIL ${fail} ==`)
  process.exit(fail > 0 ? 1 : 0)
}
