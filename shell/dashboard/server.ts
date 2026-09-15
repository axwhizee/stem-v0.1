// ============================================================
// shell/dashboard/server.ts —— 空间仪表盘（法医/管理员 shell，端口 4421）
//
// 与 WebUI 真并列：本进程不装运行系统——族谱/token/语料全部来自
// SQLite 持久层（write-through 实时镜像）只读直查；资源清单来自
// 纯内存标本装配（bootStem stateStore:false，零 DB 触碰零 LLM）。
// 清理是唯一写通道：默认只读姿态，--allow-write 明示开启 +
// confirm='yes' 双门禁（同空间运行实例的写穿会覆盖删除——无锁是
// 既定约定，工具不假装检测，把知情权交给操作者）。
//
// 用法：npm run dashboard -- [空间路径]（定位同 opencode-style：
//   位置参数 > STEM_PROJECT_ROOT > cwd）；STEM_DASHBOARD_PORT 覆盖端口。
// ============================================================

import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { cleanupPreview, runCleanup, type CleanupAction } from './cleanup'
import { dbBytes, dashAgents, listMessages, openDb, rawTable, summary, tokenStats } from './db'
import { getInventory } from './inventory'
import { resolveProjectRoot } from '../cli/platform'
import { readJsonBody, sendJson, sendStatic as sendStaticShared } from '../cli/http'

const PORT = Number(process.env.STEM_DASHBOARD_PORT ?? 4421)
const HOST = process.env.STEM_HOST ?? '127.0.0.1'
// 空间定位与 cli 同律（platform.resolveProjectRoot）。
const PROJECT_ROOT = resolveProjectRoot()
const ALLOW_WRITE = process.argv.includes('--allow-write')

const DB_FILE = process.env.STEM_DB_PATH ?? join(PROJECT_ROOT, '.stem', 'stem.db')

/** 只读连接（懒开 + 常开——法医视图高频查询）。 */
let readConn: DatabaseSync | undefined
function db(): DatabaseSync | undefined {
  if (readConn === undefined) readConn = openDb(DB_FILE)
  return readConn
}
let writeConn: DatabaseSync | undefined
function dbWrite(): DatabaseSync | undefined {
  if (!ALLOW_WRITE) return undefined
  if (writeConn === undefined) {
    writeConn = new DatabaseSync(DB_FILE)
    writeConn.exec('PRAGMA busy_timeout = 5000')
  }
  return writeConn
}

function sendStatic(res: ServerResponse, file: string, contentType: string): void {
  sendStaticShared(res, new URL(file, import.meta.url), contentType, { cache: 'no-store', missingStatus: 404 })
}

const readBody = readJsonBody

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname
  try {
    // —— 静态（前端自包含：app/style 本地 + view.js 复用 webui 纯函数核心）——
    if (req.method === 'GET') {
      if (path === '/' || path === '/index.html') return sendStatic(res, './public/index.html', 'text/html; charset=utf-8')
      if (path === '/app.js') return sendStatic(res, './public/app.js', 'text/javascript; charset=utf-8')
      if (path === '/style.css') return sendStatic(res, './public/style.css', 'text/css; charset=utf-8')
      if (path === '/view.js') return sendStatic(res, '../webui/view.js', 'text/javascript; charset=utf-8')

      if (path === '/api/health') {
        return sendJson(res, { ok: true, project: PROJECT_ROOT, db: dbBytes(DB_FILE) > 0, allowWrite: ALLOW_WRITE, port: PORT })
      }
      const handle = path.startsWith('/api/')
      if (!handle) {
        res.writeHead(404)
        return res.end('not found')
      }
      const store = db()
      if (path === '/api/stats') {
        if (store === undefined) return sendJson(res, { db: false, project: PROJECT_ROOT, dbBytes: 0 })
        return sendJson(res, { db: true, project: PROJECT_ROOT, ...summary(store, DB_FILE) })
      }
      if (path === '/api/agents') {
        if (store === undefined) return sendJson(res, [])
        return sendJson(res, dashAgents(store))
      }
      if (path === '/api/tokens') {
        if (store === undefined) return sendJson(res, { byAgent: [], byDay: [], total: { msgs: 0, tokens: 0 } })
        return sendJson(res, tokenStats(store))
      }
      if (path === '/api/messages') {
        if (store === undefined) return sendJson(res, { rows: [], total: 0 })
        return sendJson(
          res,
          listMessages(store, {
            agentId: url.searchParams.get('agentId') ?? undefined,
            limit: Number(url.searchParams.get('limit') ?? 100),
            offset: Number(url.searchParams.get('offset') ?? 0),
            includeArchived: url.searchParams.get('archived') === '1',
          }),
        )
      }
      if (path === '/api/raw') {
        if (store === undefined) return sendJson(res, { columns: [], rows: [], total: 0 })
        const table = url.searchParams.get('table') ?? 'instances'
        if (table !== 'messages' && table !== 'instances' && table !== 'spaces') {
          return sendJson(res, { error: 'table 必须 messages|instances|spaces' }, 400)
        }
        return sendJson(res, rawTable(store, table, Number(url.searchParams.get('limit') ?? 50), Number(url.searchParams.get('offset') ?? 0)))
      }
      if (path === '/api/inventory') {
        return sendJson(res, await getInventory(PROJECT_ROOT, url.searchParams.get('refresh') === '1'))
      }
      if (path === '/api/cleanup/preview') {
        if (store === undefined) return sendJson(res, { error: '空间尚无 DB' }, 404)
        return sendJson(res, { preview: cleanupPreview(store), allowWrite: ALLOW_WRITE })
      }
      res.writeHead(404)
      return res.end('not found')
    }

    if (req.method === 'POST' && path === '/api/cleanup') {
      if (!ALLOW_WRITE) {
        return sendJson(res, { ok: false, note: '仪表盘运行于只读姿态（清理需 --allow-write 启动）' }, 403)
      }
      const body = await readBody(req)
      if (body.confirm !== 'yes') return sendJson(res, { ok: false, note: '缺少 confirm=yes（双确认门禁）' }, 400)
      const action = body.action as CleanupAction
      if (!['gc-orphans', 'gc-terminated', 'purge-agent', 'vacuum'].includes(String(action))) {
        return sendJson(res, { ok: false, note: `未知动作 ${String(action)}` }, 400)
      }
      const store = dbWrite()
      if (store === undefined) return sendJson(res, { ok: false, note: 'DB 不存在' }, 404)
      const result = runCleanup(store, action, {
        ...(typeof body.agentId === 'string' ? { agentId: body.agentId } : {}),
        ...(body.force === true ? { force: true } : {}),
      })
      return sendJson(res, result)
    }
    res.writeHead(405)
    res.end('method not allowed')
  } catch (cause) {
    sendJson(res, { error: cause instanceof Error ? cause.message : String(cause) }, 500)
  }
})

server.listen(PORT, HOST, () => {
  console.log(`stem Dashboard → http://${HOST}:${PORT}`)
  console.log(`  project: ${PROJECT_ROOT}`)
  console.log(`  db: ${DB_FILE}（${dbBytes(DB_FILE) > 0 ? '存在' : '尚未出生'}），写姿态: ${ALLOW_WRITE ? '⚠ allow-write' : '只读'}`)
})
