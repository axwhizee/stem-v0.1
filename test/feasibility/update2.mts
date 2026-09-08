// ============================================================
// test/feasibility/update2.mts —— 用例 #2 + #3 编排：
// 真模型驱动进化书写（create→ask→落盘）+ update 收敛铁律（降序放行/升序被拒）
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
async function waitTurn(id: string, min: number, t = 150): Promise<boolean> {
  const end = Date.now() + t * 1000
  while (Date.now() < end) { await sleep(2000); const a = (await agents()).find((x) => x.id === id); if (a && a.turnCount >= min && a.status !== 'thinking') return true; }
  return false
}
async function userLetterText(): Promise<string> {
  const d = (await (await fetch(B + '/api/agents/0/context')).json()) as { messages: Array<{ role: string; content?: string }> }
  return d.messages.map((m) => String(m.content ?? '')).join('\n')
}
async function waitForRequest(agent: string, accessKey: string, minCount = 1, t = 90): Promise<string | undefined> {
  const end = Date.now() + t * 1000
  const re = new RegExp(`<access_request id="([^"]+)" accessKey="${accessKey}"[^>]*agentId="${agent}"`, 'g')
  while (Date.now() < end) {
    const hits = [...(await userLetterText()).matchAll(re)]
    if (hits.length >= minCount) return hits.at(-1)?.[1]
    await sleep(3000)
  }
  return undefined
}
const countReq = async (agent: string, key: string) => [...(await userLetterText()).matchAll(new RegExp(`accessKey="${key}"[^>]*agentId="${agent}"`, 'g'))].length
const turnOf = async (id: string) => agents().then((l) => l.find((a) => a.id === id)?.turnCount ?? -1)
const corpus = async (id: string) => JSON.stringify(await (await fetch(`${B}/api/agents/${id}/context`)).json())

const { agentId } = await post('/api/instantiate', { className: 'triple', userPrompt: '你好，等你指令。' })
const id = String(agentId)
let base = await turnOf(id)

// ---------- I1 #2：create 落盘 ----------
await post('/api/send', { to: id, text: '用 agent_class_create 创建类 scribe：description="书记员（验收 #2 产物）"，systemPrompt="你是书记员，复述用户的话。"，tools 设 read=allow。这是预期内操作，直接执行。' })
const req1 = await waitForRequest(id, 'agent_class_create', 1)
ok('I1 create 申请到达根信箱', req1 !== undefined)
await post('/api/access', { requestId: req1, reply: 'once' })
await waitTurn(id, base + 1)
base = await turnOf(id)
const tmpls = async () => (await fetch(`${B}/api/templates`).then((r) => r.json())) as Array<{ name: string; tools?: Record<string, string> }>
ok('I1 scribe 类注册进模板表', (await tmpls()).some((t) => t.name === 'scribe'))
// ---------- I2 #3a：update 降序合法（read allow→deny）+ 描述改动 ----------
await post('/api/send', { to: id, text: '用 agent_class_update 更新 scribe 类：tools 把 read 改为 deny。预期该操作合法（allow→deny 属收敛）。' })
const req2 = await waitForRequest(id, 'agent_class_update', 1)
ok('I2 update 申请到达根信箱', req2 !== undefined)
await post('/api/access', { requestId: req2, reply: 'once' })
await waitTurn(id, base + 1)
base = await turnOf(id)
ok('I2 降序更新生效（scribe.read=deny）', (await tmpls()).find((t) => t.name === 'scribe')?.tools?.read === 'deny', JSON.stringify((await tmpls()).find((t) => t.name === 'scribe')))
// ---------- I3 #3b：update 升序被拒（deny→allow 扩张）----------
await post('/api/send', { to: id, text: '再用 agent_class_update 把 scribe 的 read 从 deny 改回 allow。' })
let rejected = false
for (let i = 0; i < 30; i++) {
  await sleep(2000)
  const c = await corpus(id)
  if (/扩张|违例|拒|violat|denied|不可回|只能收敛/.test(c)) { rejected = true; break }
  const a = (await agents()).find((x) => x.id === id)
  if (a && a.turnCount >= base + 1 && a.status !== 'thinking') { rejected = /扩张|违例|拒|violat|denied|只能收敛/.test(c); break }
}
ok('I3 deny→allow 升序扩张被拒（错误回模型）', rejected, (await corpus(id)).slice(-200))
const n3 = await countReq(id, 'agent_class_update')
ok('I3 扩张被拒发生在审批之前（不产生第三封申请）', n3 === 1, `count=${n3}`)
console.log(`\n== create/update 档：PASS ${pass} / FAIL ${fail} ==`)
process.exit(fail > 0 ? 1 : 0)
