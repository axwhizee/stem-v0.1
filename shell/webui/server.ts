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
import { join } from 'node:path'
import { bootStem, demoTemplatesHook } from '../cli/platform'
import type { PilotEvent } from '../../src/core/events'
import type { StemSystem } from '../../src/core/init'

const PORT = Number(process.env.PORT ?? 4321)
/** 绑定地址：裸机默认仅本机（127.0.0.1）；容器内由 STEM_HOST=0.0.0.0 放开（端口映射需要）。 */
const HOST = process.env.STEM_HOST ?? '127.0.0.1'
const PROJECT_ROOT = process.env.STEM_PROJECT_ROOT ?? join(process.cwd(), 'tmp')

// ---------- SSE 广播 ----------

const clients = new Set<ServerResponse>()

function broadcast(event: PilotEvent): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`
  for (const res of clients) {
    res.write(payload)
  }
}

// ---------- 服务器 ----------

async function main(): Promise<void> {
  const { system, source } = await bootStem({
    projectRoot: PROJECT_ROOT,
    onEvent: broadcast,
    userHooks: [demoTemplatesHook],
  })

  // 首次启动：除 user0 外无任何 agent 时创建一个 simple-chat（供直接对话）。
  const existing = await system.pilot.listAgents()
  if (existing.every((a) => a.id === 'user0')) {
    await system.pilot.instantiate(
      { className: 'simple-chat', userPrompt: '你好，请做一个简短的自我介绍。' },
      PROJECT_ROOT,
    )
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const path = url.pathname

      // —— 静态页 ——
      if (req.method === 'GET' && path === '/') return sendHtml(res)
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
      if (req.method === 'GET' && path.startsWith('/api/agents/') && path.endsWith('/context')) {
        const agentId = decodeURIComponent(path.slice('/api/agents/'.length, -'/context'.length))
        return sendJson(res, await contextOf(system, agentId))
      }
      // —— 扮演（user0 action） ——
      if (req.method === 'POST') {
        const body = await readBody(req)
        if (path === '/api/send') {
          await system.pilot.sendMessage(String(body.to), String(body.text))
          return sendJson(res, { ok: true })
        }
        if (path === '/api/instantiate') {
          const agentId = await system.pilot.instantiate(
            { className: String(body.className), userPrompt: String(body.userPrompt) },
            PROJECT_ROOT,
          )
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
        if (path === '/api/access') {
          await system.pilot.replyAccess({
            requestId: String(body.requestId),
            reply: body.reply as 'once' | 'always' | 'reject',
            ...(body.message !== undefined ? { message: String(body.message) } : {}),
          })
          return sendJson(res, { ok: true })
        }
        if (path === '/api/context_action') {
          // 上下文策略专有动作（pilot 通道 = user0 根授权；如 classic compact）。
          const result = await system.pilot.runContextAction(
            String(body.agentId ?? 'user0'),
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

  // 优雅收尾。
  const shutdown = () => {
    system.dispose()
    server.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// ---------- 辅助 ----------

async function listAgents(system: StemSystem): Promise<Array<Record<string, unknown>>> {
  const agents = await system.pilot.listAgents()
  return agents.map((a) => ({
    id: a.id,
    displayName: a.displayName,
    classRef: a.classRef,
    parentId: a.parentId,
    status: a.status,
    turnCount: a.turnCount,
  }))
}

async function contextOf(system: StemSystem, agentId: string): Promise<{ agentId: string; messages: unknown[] }> {
  const state = await system.kernel.contextManager.getState(agentId)
  return {
    agentId,
    messages: state.messages.map((m) => ({
      id: m.id,
      role: m.message.role,
      content: typeof m.message.content === 'string' ? m.message.content : JSON.stringify(m.message.content),
      ...(m.from !== undefined ? { from: m.from } : {}),
      ...(m.tag !== undefined ? { tag: m.tag } : {}),
      turn: m.turn,
      indexInTurn: m.indexInTurn,
      valid: m.valid,
    })),
  }
}

function sendHtml(res: ServerResponse): void {
  readFile(new URL('./index.html', import.meta.url))
    .then((buf) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(buf)
    })
    .catch(() => {
      res.writeHead(500)
      res.end('index.html 读取失败')
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