// ============================================================
// test/feasibility/ask3.mts —— 用例 #6 编排：ask 三分支（once/always/reject）
// 走 webui API（= 用户操作面）。判据打在输出上供人工审。
// 前提：space-v10 已装载 triple 类（webui 在跑）。
// ============================================================
const B = 'http://127.0.0.1:4321'

// 前置守卫：本件为在线编排档，需 webui 已在运行（test:feas 容忍 rc=2 记为跳过）。
if (!(await fetch('http://127.0.0.1:4321/api/health').then((r) => r.ok).catch(() => false))) {
  console.log('跳过：webui 未起（先跑 timeout 60 bash test/feasibility/tools/up.sh webui）')
  process.exit(2)
}
let pass = 0; let fail = 0
const ok = (n: string, c: unknown, e = '') => { if (c) { pass++; console.log(`  PASS  ${n}`) } else { fail++; console.log(`  FAIL  ${n}  ${e}`) } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const post = async (p: string, b: Record<string, unknown>) => (await fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json() as Promise<Record<string, string | undefined>>
const agents = async () => (await (await fetch(B + '/api/agents')).json()) as Array<{ id: string; status: string; turnCount: number }>
const turnOf = async (id: string) => agents().then((l) => l.find((a) => a.id === id)?.turnCount ?? -1)
async function waitTurn(id: string, min: number, t = 120) { const e = Date.now() + t * 1000; while (Date.now() < e) { await sleep(2000); const tn = await turnOf(id); const st = (await agents()).find((a) => a.id === id)?.status; if (tn >= min && st !== 'thinking') return true } return false }
const userLetters = async () => {
  const d = (await (await fetch(B + '/api/agents/0/context')).json()) as { messages: Array<{ role: string; content?: string }> }
  return d.messages.map((m) => String(m.content ?? '')).filter((c) => c.includes('<access_request')).join('\n')
}
const lastRequestId = (letters: string, contains: string): string | undefined => {
  const hits = [...letters.matchAll(/<access_request id="([^"]+)"[\s\S]*?<\/access_request>/g)]
  return hits.filter(([, , body]) => (body ?? '').includes(contains) || true).map(([, rid, body]) => (body.includes(contains) ? rid : undefined)).filter(Boolean).at(-1)
}
// 轮询等待"含指定 accessKey 的新申请"出现（instantiate/send 后模型跑轮需时——
// 直读信箱必竞态，首轮 FAIL 的实因）。
async function waitForRequest(agent: string, accessKey: string, minCount = 1, t = 60): Promise<string | undefined> {
  const end = Date.now() + t * 1000
  while (Date.now() < end) {
    const L = await userLetters()
    const hits = [...L.matchAll(/<access_request id="([^"]+)"[^>]*accessKey="([^"]+)"[^>]*agentId="([^"]+)"/g)]
      .filter((m) => m[2] === accessKey && m[3] === agent)
    if (hits.length >= minCount) return hits.at(-1)?.[1]
    await sleep(3000)
  }
  return undefined
}


const { agentId } = await post('/api/instantiate', { className: 'triple', userPrompt: '调用 agent_class_list 工具，把返回内容的第一行报给我。（这会被询问审批，正常等待）' })
const id = String(agentId)
console.log('triple instance =', id)

let base = await turnOf(id)
// ---------- R1 once（等申请出现再批） ----------
const req = await waitForRequest(id, 'agent_class_list', 1)
ok('R1 ask 申请到达根信箱', req !== undefined)
await post('/api/access', { requestId: req, reply: 'once' })
await waitTurn(id, base + 1)
let corpus = JSON.stringify(await (await fetch(`${B}/api/agents/${id}/context`)).json())
ok('R1 once 批准后执行（工具结果回库）', corpus.includes('agent 类列表'), corpus.slice(-160))

// ---------- R2 再问 → always ----------
base = await turnOf(id)
await post('/api/send', { to: id, text: '再次调用 agent_class_list。' })
const req2 = await waitForRequest(id, 'agent_class_list', 2)
ok('R2 once 是一次性——同键再次被问（信箱第二封申请）', req2 !== undefined)
await post('/api/access', { requestId: req2, reply: 'always' })
await waitTurn(id, base + 1)

// ---------- R3 always 豁免 ----------
base = await turnOf(id)
await post('/api/send', { to: id, text: '第三次调用 agent_class_list，直接执行不必等审批。' })
await waitTurn(id, base + 1)
const L3 = await userLetters()
// 按当前实例过滤（根信箱跨实例累积——首轮未过滤致假 FAIL 的教训）
const total3 = (L3.match(new RegExp(`accessKey="agent_class_list"[^>]*agentId="${id}"`, 'g')) ?? []).length
ok('R3 always 豁免生效（本实例申请数仍为 2，第三轮零新增）', total3 === 2, `total=${total3}`)

// ---------- R4 另一键照常问 → reject ----------
base = await turnOf(id)
await post('/api/send', { to: id, text: '调用 websearch 搜「西湖 城市」一次。' })
const req4 = await waitForRequest(id, 'websearch', 1)
ok('R4 另一键（websearch）不受 always 豁免——照常申请', req4 !== undefined)
await post('/api/access', { requestId: req4, reply: 'reject', message: '本试验禁止网络检索' })
await waitTurn(id, base + 1)
corpus = JSON.stringify(await (await fetch(`${B}/api/agents/${id}/context`)).json())
ok('R4 reject 反馈文本进入模型上下文（被拒有交代）', /禁止|拒绝|reject|未执行/i.test(corpus), corpus.slice(-300))
ok('R4 未产生搜索结果（websearch 确实没执行）', !corpus.includes('杭州'))

console.log(`\n== ask 三分支：PASS ${pass} / FAIL ${fail} ==`)
process.exit(fail > 0 ? 1 : 0)
