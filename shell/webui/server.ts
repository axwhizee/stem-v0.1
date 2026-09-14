// ============================================================
// shell/webui/server.ts —— WebUIShell（浏览器交互层）
//
// 复用 cli 的节点平台（bootStem + fs 工具 + 示例模板），对外提供
// HTTP + SSE：浏览器经 REST/事件流与 stem 自治系统交互。
//   - 扮演：/api/send、/api/instantiate、/api/terminate、/api/access…
//   - 观察：/api/agents、/api/agents/:id/context、/api/templates、/api/events(SSE)、/api/health
// ============================================================

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { bootStem } from '../cli/platform'
import { makeAgentClassID } from '../../src/core/kernel'
import type { AgentClass } from '../../src/core/kernel'
import type { PilotEvent } from '../../src/core/events'
import type { StemSystem } from '../../src/core/main'

const PORT = Number(process.env.PORT ?? 4321)
/** 绑定地址：裸机默认仅本机（127.0.0.1）；容器内由 STEM_HOST=0.0.0.0 放开（端口映射需要）。 */
const HOST = process.env.STEM_HOST ?? '127.0.0.1'
/** S6/R11 opencode-style 空间定位：位置参数 > STEM_PROJECT_ROOT > cwd（一进程一空间，无切换器）。 */
// 空间定位与 cli 同规则：首个非 flag 参数（防 '--' 透传符鬼空间）。
const PROJECT_ROOT = resolve(process.argv.slice(2).find((a) => !a.startsWith('-')) ?? process.env.STEM_PROJECT_ROOT ?? process.cwd())

// ---------- SSE 广播 ----------

const clients = new Set<ServerResponse>()

function broadcast(event: PilotEvent): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`
  for (const res of clients) {
    res.write(payload)
  }
}

// ---------- 服务器 ----------


// —— 宿主卫生（验收 P6 现场：孤儿 promise 曾直接击落进程）——
// unhandledRejection 记录完整对象并存活（core 判别联合对象默认 toString 为空，
// 用 JSON 展开）；定位各真凶后逐一补 catch，本钩子兜最后一道。
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', (() => { try { return JSON.stringify(reason) } catch { return String(reason) } })())
})

async function main(): Promise<void> {
  const { system, source } = await bootStem({
    projectRoot: PROJECT_ROOT,
    onEvent: broadcast,
  })

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const path = url.pathname

      // —— 静态页（index + 样式 + 应用脚本 + 视图纯函数模块；三件套分文件） ——
      if (req.method === 'GET' && path === '/') return sendStatic(res, 'index.html', 'text/html; charset=utf-8')
      if (req.method === 'GET' && path === '/style.css') return sendStatic(res, 'style.css', 'text/css; charset=utf-8')
      if (req.method === 'GET' && path === '/app.js') return sendStatic(res, 'app.js', 'text/javascript; charset=utf-8')
      if (req.method === 'GET' && path === '/view.js') return sendStatic(res, 'view.js', 'text/javascript; charset=utf-8')
      // —— 健康检查（docker HEALTHCHECK / 反探活） ——
      if (req.method === 'GET' && path === '/api/health') {
        const agents = await system.pilot.listAgents()
        return sendJson(res, { ok: true, gateway: source, agents: agents.length, uptimeSec: Math.round(process.uptime()) })
      }
      // —— SSE 事件流 ——
      if (req.method === 'GET' && path === '/api/events') return openSse(res)
      // —— 观察（仪表盘） ——
      if (req.method === 'GET' && path === '/api/agents') return sendJson(res, await listAgents(system))
      if (req.method === 'GET' && path === '/api/templates') return sendJson(res, await system.kernel.templates.list())
      if (req.method === 'GET' && path === '/api/models') return sendJson(res, listModels(system))
      if (req.method === 'GET' && path.startsWith('/api/agents/') && path.endsWith('/context')) {
        const agentId = decodeURIComponent(path.slice('/api/agents/'.length, -'/context'.length))
        return sendJson(res, await contextOf(system, agentId))
      }
      // —— 扮演（根 action） ——
      if (req.method === 'POST') {
        const body = await readBody(req)
        if (path === '/api/send') {
          await system.pilot.sendMessage(String(body.to), String(body.text))
          return sendJson(res, { ok: true })
        }
        if (path === '/api/instantiate') {
          const opts: Parameters<typeof system.pilot.instantiate>[0] = {
            className: String(body.className),
            userPrompt: String(body.userPrompt),
          }
          // 模型三环·环一：出生显式（"提供商/模型" 全严格式；缺省 = 落继承链）
          if (typeof body.model === 'string' && body.model !== '') {
            const model = parseModel(body.model)
            if (model === undefined) return sendJson(res, { error: 'model 必须是 "提供商/模型" 格式' }, 400)
            opts.model = model
          }
          // 出生称呼（缺省 = 确定性派生 类名-N；撞全局名被拒——pilot 执法）。
          if (typeof body.name === 'string' && body.name.trim() !== '') opts.name = body.name.trim()
          const agentId = await system.pilot.instantiate(opts, PROJECT_ROOT)
          return sendJson(res, { ok: true, agentId })
        }
        if (path === '/api/terminate') {
          await system.pilot.terminate(String(body.agentId), { recursive: Boolean(body.recursive) })
          return sendJson(res, { ok: true })
        }
        if (path === '/api/interrupt') {
          await system.pilot.interrupt(String(body.agentId))
          return sendJson(res, { ok: true })
        }
        if (path === '/api/set_model') {
          // 运行时换模型（扮演通道，pilot.setModel = 根授权）。
          const model = parseModel(String(body.model ?? ''))
          if (model === undefined) return sendJson(res, { error: 'model 必须是 "提供商/模型" 格式' }, 400)
          await system.pilot.setModel(String(body.agentId ?? '0'), model)
          return sendJson(res, { ok: true })
        }
        if (path === '/api/update') {
          // 实例参数写口（批 3 改名等；by 缺省 = 宿主信任通道，同 pilot 语义）。
          const agentId = String(body.agentId)
          const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : undefined
          await system.kernel.updateAgent({ agentId, ...(name !== undefined ? { name } : {}) })
          return sendJson(res, { ok: true })
        }
        if (path === '/api/class_update') {
          // 类定义进化面（设置面板类页签）：同名合并 + 落盘（只影响后续实例）；
          // panel/user 红线由 serialize 拒写、未知类由 templates.get 抛——统一 400。
          const clsName = String(body.name)
          const patch: Partial<AgentClass> = {
            ...(typeof body.description === 'string' ? { description: body.description } : {}),
            ...(typeof body.systemPrompt === 'string' ? { systemPrompt: body.systemPrompt } : {}),
            ...(body.contextStrategy === 'classic' || body.contextStrategy === 'none' || body.contextStrategy === 'cortex'
              ? { contextStrategy: String(body.contextStrategy) }
              : {}),
          }
          const r = await system.kernel.updateAgentClass(makeAgentClassID(clsName), patch, { persist: true })
          return sendJson(res, { ok: true, persisted: r.persisted })
        }
        if (path === '/api/access') {
          await system.pilot.replyAccess({
            requestId: String(body.requestId),
            reply: body.reply as 'once' | 'always' | 'reject',
            ...(body.message !== undefined ? { message: String(body.message) } : {}),
          })
          return sendJson(res, { ok: true })
        }
        if (path === '/api/context_action') {
          // 上下文策略专有动作（pilot 通道 = 根授权；如 classic compact）。
          const result = await system.pilot.runContextAction(
            String(body.agentId ?? '0'),
            String(body.action),
            body.args !== undefined ? String(body.args) : '',
          )
          return sendJson(res, { ok: true, result })
        }
      }
      return sendJson(res, { error: 'not found' }, 404)
    } catch (error) {
      // core 错误是判别联合对象（非 Error 实例）——String() 会变 [object Object]，序列化保真。
      const message = error instanceof Error ? error.message : JSON.stringify(error)
      return sendJson(res, { error: message }, 500)
    }
  })

  server.listen(PORT, HOST, () => {
    console.log(`stem WebUIShell → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`)
    console.log(`  gateway: ${source}   project: ${PROJECT_ROOT}`)
    console.log('  Ctrl+C 退出（中断所有活跃 agent）')
  })

  // 优雅收尾：dispose 必须 await（中断活跃轮 → 消息闭合与状态归一化
  // 落行后才退——同步 exit 会把进行中的轮次快照吞掉，重启即丢账目/状态）。
  let exiting = false
  const shutdown = () => {
    if (exiting) { process.exit(130); return }
    exiting = true
    system.dispose()
      .catch((e: unknown) => console.error('[shutdown]', e))
      .finally(() => { server.close(); process.exit(0) })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// ---------- 辅助 ----------

/** 严格模型引用解析（"提供商/模型"，两段非空；S6/R6）。 */
function parseModel(value: string): { provider: string; id: string } | undefined {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) }
}

async function listAgents(system: StemSystem): Promise<Array<Record<string, unknown>>> {
  const agents = await system.pilot.listAgents()
  return agents.map((a) => {
    const node = system.kernel.lineage.nodeOf(a.id as never)
    const binding = node?.model
    // 侧栏行摘要 = 最近一条 user 信剥 <sender>（view.js truncate 渲染）。
    const rows = [...system.kernel.repository.list(a.id)]
    const lastUser = [...rows].reverse().find((m) => m.message.role === 'user')
    const rawContent = typeof lastUser?.message.content === 'string' ? lastUser.message.content : ''
    const sender = /^<sender id="([^"]+)"(?: at="[^"]*")?>/.exec(rawContent)?.[1] ?? ''
    const facts = system.kernel.contextManager.boxFacts(a.id)
    let lastActive = 0
    for (const m of rows) {
      if (m.at > lastActive) lastActive = m.at
    }
    return {
      id: a.id,
      name: a.name,
      classRef: a.classRef,
      parentId: a.parentId,
      status: a.status,
      turnCount: a.turnCount,
      totalCost: a.totalCost,
      totalTokens: a.totalTokens ?? 0,
      ...(facts !== undefined ? { strategy: facts.strategy, sendCountdownMs: facts.sendCountdownMs } : {}),
      // 反馈式占用（最近 prompt_tokens）；旧行无值时回落仓库估算。
      ctxTokens: a.ctxTokens ?? rows.filter((m) => m.valid).reduce((s, m) => s + m.tokens, 0),
      ...(lastActive > 0 ? { lastActive } : {}),
      ...(binding !== undefined ? { model: `${binding.ref.provider}/${binding.ref.id}`, modelOrigin: binding.origin } : {}),
      ...(rawContent !== '' ? { lastPrompt: rawContent.replace(/^<sender id="[^"]+">/, '').replace(/<\/sender>$/, ''), lastPromptFrom: sender } : {}),
    }
  })
}

/** 模型候选（header 下拉）：providers 白名单展开；models 空 = 该 provider 全启用。 */
function listModels(system: StemSystem): { refs: string[]; openEnded: string[] } {
  const refs: string[] = []
  const openEnded: string[] = []
  for (const [name, provider] of Object.entries(system.config.providers ?? {})) {
    if (provider.models !== undefined && provider.models.length > 0) refs.push(...provider.models.map((m) => `${name}/${m}`))
    else openEnded.push(name)
  }
  return { refs, openEnded }
}

async function contextOf(system: StemSystem, agentId: string): Promise<{ agentId: string; contextWindow: number; messages: unknown[] }> {
  const state = await system.kernel.contextManager.getState(agentId)
  return {
    agentId,
    // 模型窗口上限（context.window）——WebUI 底部占用进度条分母。
    contextWindow: system.config.context?.window ?? 1000000,
    messages: state.messages.map((m) => ({
      id: m.id,
      role: m.message.role,
      content: typeof m.message.content === 'string' ? m.message.content : JSON.stringify(m.message.content),
      ...(m.from !== undefined ? { from: m.from } : {}),
      ...(m.tag !== undefined ? { tag: m.tag } : {}),
      // 工具轨迹透传（审计证据面：assistant 行发起过哪些调用必须可见）。
      ...(((m.message as { toolCalls?: unknown }).toolCalls) !== undefined ? { toolCalls: (m.message as { toolCalls?: unknown }).toolCalls } : {}),
      // 工具行归属戳（assistant.toolCalls.id → 本行 toolCallId 关联，前端据此还原工具名）。
      ...(((m.message as { toolCallId?: string }).toolCallId) !== undefined ? { toolCallId: (m.message as { toolCallId?: string }).toolCallId } : {}),
      tokens: m.tokens,
      at: m.at,
      turn: m.turn,
      indexInTurn: m.indexInTurn,
      valid: m.valid,
    })),
  }
}

function sendStatic(res: ServerResponse, file: string, contentType: string): void {
  readFile(new URL('./' + file, import.meta.url))
    .then((buf) => {
      // no-cache：每次携带协商——升级后浏览器不会拿启发式缓存的新旧混拼 JS
      // （2026-09 现场：view.js/app.js 混版导致思维链字段错位空流与历史不刷新）。
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' })
      res.end(buf)
    })
    .catch(() => {
      res.writeHead(500)
      res.end(`${file} 读取失败`)
    })
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function openSse(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.write('retry: 1000\n\n')
  clients.add(res)
  res.on('close', () => clients.delete(res))
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString()
    })
    req.on('end', () => {
      try {
        resolve(data === '' ? {} : (JSON.parse(data) as Record<string, unknown>))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

main()
  .then(() => undefined)
  .catch((error: unknown) => {
    console.error('[fatal]', error)
    process.exit(1)
  })