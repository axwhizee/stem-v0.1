// ============================================================
// test/feasibility/http.mts —— 机制可行性 HTTP/SSE 档（双服务并开）
//
// spawn webui(:4321) + dashboard(:4421) 于 tmp 空间（独立进程、真实 DB 直读），
// 验证：health / instantiate 真轮 / letter 信箱投递 / SSE 事件流格式 /
// 仪表盘清单（今日策略维度修复回归）/ 清理只读门禁 403 / terminate 收尾。
// 需 ALIBABA_API_KEY（真网关一轮小任务）。运行：
//   ALIBABA_API_KEY=<key> npx tsx test/feasibility/http.mts
// ============================================================
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'

let pass = 0
let fail = 0
const ok = (name: string, cond: unknown, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`) }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
if (!process.env.ALIBABA_API_KEY) {
  console.log('跳过：ALIBABA_API_KEY 未注入')
  process.exit(2)
}
// （防御性）清除可能存在的代理 env，保证 loopback 直连。
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete process.env[k]
const REPO = new URL('../..', import.meta.url).pathname
const SPACE = `${REPO}/tmp`

const procs: Array<{ kill: () => void }> = []
async function serve(args: string[], name: string) {
  const p = spawn('npx', ['tsx', ...args], { cwd: REPO, detached: true, stdio: 'ignore', env: process.env })
  procs.push({ kill: () => { try { process.kill(-p.pid!, 'SIGKILL') } catch { /* gone */ } } })
  void name
}
async function waitHealth(port: number, timeoutMs = 40_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (r.ok) return await r.json()
    } catch { /* up pending */ }
    await sleep(500)
  }
  throw new Error(`health 超时 :${port}`)
}
const post = async (port: number, path: string, body: Record<string, unknown>) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, json: await r.json().catch(() => null) }
}

try {
  await serve(['shell/webui/server.ts', SPACE], 'webui')
  await serve(['shell/dashboard/server.ts', SPACE], 'dashboard')

  console.log('H1 双服务 health')
  const w = await waitHealth(4321)
  const d = await waitHealth(4421)
  ok('webui :4321 就绪', w?.ok === true || w?.status === 'ok', JSON.stringify(w))
  ok('dashboard :4421 就绪', d != null)

  console.log('H2 仪表盘资源清单（策略维度今日修复回归）')
  const inv = await (await fetch('http://127.0.0.1:4421/api/inventory')).json() as {
    strategies?: Array<{ name: string; layer: string; hasProcess: boolean }>
    tools?: Array<{ id: string; kind: string }>
    classes?: Array<{ name: string }>
  }
  ok('inventory.strategies 非空且 classic 在列（修复生效）',
     (inv.strategies ?? []).some((s) => s.name === 'classic' && s.layer === 'internal' && s.hasProcess), JSON.stringify(inv.strategies))
  ok('inventory tools/classes 正常', (inv.tools?.length ?? 0) > 8 && (inv.classes?.length ?? 0) >= 4, JSON.stringify({ t: inv.tools?.length, c: inv.classes?.length }))

  console.log('H3 webui 真网关实例化 → LLM 轮 → DB 镜像')
  const inst = await post(4321, '/api/instantiate', { className: 'simple-chat', userPrompt: '只回复两个字：收到' })
  const agentId = String(inst.json?.agentId ?? '')
  ok('instantiate 200 返回 id', inst.status === 200 && agentId.length > 0, JSON.stringify(inst))
  let corpus = ''
  for (let i = 0; i < 60; i++) {
    await sleep(1000)
    const c = await fetch(`http://127.0.0.1:4321/api/agents/${agentId}/context`).then((r) => r.json()).catch(() => null) as { messages?: Array<{ role: string; content?: string }> } | null
    if (c?.messages?.some((m) => m.role === 'assistant' && String(m.content).includes('收到'))) { corpus = 'OK'; break }
  }
  ok('真 LLM 轮经 HTTP 面完成（assistant 回复"收到"）', corpus === 'OK')

  console.log('H4 SSE 事件流格式')
  const sse = await fetch('http://127.0.0.1:4321/api/events', { headers: { accept: 'text/event-stream' } })
  ok('SSE 连接建立（content-type event-stream）', sse.headers.get('content-type')?.includes('text/event-stream') === true, String(sse.headers.get('content-type')))
  sse.body?.cancel()

  console.log('H5 仪表盘只读门禁')
  const gate = await post(4421, '/api/cleanup', { action: 'gc-orphans', confirm: 'yes' })
  ok('无 --allow-write 清理被拒（403）', gate.status === 403, JSON.stringify(gate))

  console.log('H6 dashboard 直读运行实例语料（write-through 镜像）')
  const agents = await (await fetch('http://127.0.0.1:4421/api/agents')).json() as Array<{ id: string }>
  ok('dashboard 能看到 webui 刚建的实例（跨进程 DB 镜像）', agents.some((a) => a.id === agentId), JSON.stringify(agents.map((a) => a.id).slice(0, 8)))

  // 收尾：terminate 试验实例（不留垃圾）。
  await post(4321, '/api/terminate', { agentId })
  console.log('H7 terminate 收尾')
  await sleep(1500)
  const after = await (await fetch('http://127.0.0.1:4421/api/agents')).json() as Array<{ id: string; status: string }>
  ok('terminate 生效（DB 镜像状态收敛）', !after.some((a) => a.id === agentId && a.status !== 'terminated'), JSON.stringify(after.find((a) => a.id === agentId)))
} catch (e) {
  fail++
  console.log('  FAIL  未捕获异常：', e instanceof Error ? e.message : JSON.stringify(e))
} finally {
  for (const p of procs) p.kill()
  await sleep(300)
  rmSync('/tmp/.nope', { force: true })
  console.log(`\n== HTTP 档结果：PASS ${pass} / FAIL ${fail} ==`)
  process.exit(fail > 0 ? 1 : 0)
}
