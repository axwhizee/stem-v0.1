// ============================================================
// shell/cli/http.ts —— 节点 HTTP 助手（webui / dashboard 共用）
//
// 各 shell 只关心路由语义；成形/读体/静态缓存策略在此一处收口。
// ============================================================

import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'

export function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * 发送静态文件。
 * cache：`no-cache`（默认，每次协商——升级后防混版）/ `no-store` / 任意 Cache-Control 值。
 * missingStatus：读失败时的 HTTP 状态（webui 500 / dashboard 404）。
 */
export function sendStatic(
  res: ServerResponse,
  fileUrl: URL,
  contentType: string,
  opts?: { cache?: string; missingStatus?: number },
): void {
  const cache = opts?.cache ?? 'no-cache'
  const missingStatus = opts?.missingStatus ?? 500
  readFile(fileUrl)
    .then((buf) => {
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': cache })
      res.end(buf)
    })
    .catch(() => {
      res.writeHead(missingStatus)
      res.end(missingStatus === 404 ? 'not found' : 'static read failed')
    })
}
