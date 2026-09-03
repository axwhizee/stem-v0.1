// 场景 3 自检编排：三层组织 + 部门墙（telemetry 可见域 = 自身+后代）+ 级联裁撤。
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
const get = async (p: string) => await (await fetch(B + p)).json()
async function waitTurn(id: string, min: number, t = 240): Promise<boolean> {
  const end = Date.now() + t * 1000
  while (Date.now() < end) {
    await sleep(2500)
    const a = (await get('/api/agents') as Array<{ id: string; status: string; turnCount: number }>).find((x) => x.id === id)
    if (a && a.turnCount >= min && a.status !== 'thinking') return true
  }
  return false
}
const turnOf = async (id: string) => (await get('/api/agents') as Array<{ id: string; turnCount: number }>).find((a) => a.id === id)?.turnCount ?? -1

// L2 组织层：creator 实例建两个 worker 孙辈（部门 A 读 note.txt、部门 B 查 STEM）
const { agentId } = await post('/api/instantiate', { className: 'creator', userPrompt: '报到，等待任务。' })
const org = String(agentId)
await waitTurn(org, 1)
let base = await turnOf(org)
await post('/api/send', { to: org, text: '建两个孙辈并等待结果后汇总：1) agent_instantiate 类 worker（agentId 含 deptA），userPrompt=「read note.txt 报内容」；2) 再建 worker（agentId 含 deptB），userPrompt=「grep 搜 STEM 报命中数」。用 context_wait 收卷，最后列出两个结果。' })
await waitTurn(org, base + 1)
const agents = (await get('/api/agents')) as Array<{ id: string; parentId: string | null; classRef: string }>
const grand = agents.filter((a) => a.parentId === org)
ok('组织下孙辈成形（>=2，模型可自发多派）', grand.length >= 2 && grand.every((g) => g.parentId === org), JSON.stringify(grand.map((g) => [g.id, g.parentId])))
// 部门墙：让组织跑 telemetry_query 只看自身+后代；确认旁支（如 ramx/skii）不在结果里
base = await turnOf(org)
await post('/api/send', { to: org, text: '调用 telemetry_query（types=["tool.call"]，limit=80），把输出里出现过的所有 agentId 名单原样列出来。' })
await waitTurn(org, base + 1)
const corpus = String(JSON.stringify(await get(`/api/agents/${org}/context`)))
const outsideLeaks = ['ramx', 'skii', 'jn2c', '848r', 'eavj'].filter((x) => corpus.includes(`"${x}`) || corpus.includes(`${x} |`))
ok('部门墙：telemetry 结果不含旁支实例事件', outsideLeaks.length === 0, JSON.stringify(outsideLeaks))
ok('可见域含自身与孙辈', corpus.includes(org) && grand.every((g) => corpus.includes(g.id)), 'ids in corpus')
// 级联裁撤：terminate recursive（user0 经 API）
await post('/api/terminate', { agentId: org, recursive: true })
await sleep(3000)
// 实况口径：terminated 实例退出 webui 活跃清单；归档语料的审计面 = dashboard DB 直查。
const after = (await get('/api/agents')) as Array<{ id: string; status: string }>
ok('terminate 级联：组织与孙辈退出活跃清单（归档语义）', ![org, ...grand.map((g) => g.id)].some((gid) => after.some((a) => a.id === gid)), JSON.stringify(after.filter((a) => a.id === org).map((a) => a.status)))
for (const g of grand.slice(0, 2)) {
  const dash = await fetch(`http://127.0.0.1:4421/api/messages?agentId=${g.id}&archived=1`)
  const dj = (await dash.json().catch(() => null)) as { rows?: unknown[] } | null
  ok(`裁撤后 ${g.id} 语料在 DB 可审计（dashboard 直查）`, (dj?.rows ?? []).length > 2, JSON.stringify(dj)?.slice(0, 120))
}
console.log(`\n== 族谱协作体：PASS ${pass} / FAIL ${fail} ==`)
process.exit(fail > 0 ? 1 : 0)
