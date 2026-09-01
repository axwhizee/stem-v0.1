// ============================================================
// shell/cli/mockSse.ts —— OpenAI 兼容 SSE 流式 mock 服务器（宿主层）
//
// 双重身份（S5.2 Docker 实跑后归位 shell）：**发布形态无 key 的产品回落**
// （buildGateway mock 分支，镜像必须自带）+ 单元测试/冒烟支撑
// （test-support/mockSse.ts 兼容再导出）。
// 行为可控：认证校验 / 文本流 / reasoning / tool_calls / 错误响应。
// ============================================================

import http from 'node:http'
import type { AddressInfo } from 'node:net'

/** 一次被捕获的请求。 */
export interface MockRequest {
  readonly method: string
  readonly url: string
  readonly headers: http.IncomingHttpHeaders
  readonly body: Record<string, unknown> | undefined
}

/** mock 返回：错误响应 或 SSE 流。 */
export type MockResponse =
  | { kind: 'error'; status: number; body: Record<string, unknown> }
  | { kind: 'stream'; chunks: ReadonlyArray<Record<string, unknown>> }

export interface MockSseOptions {
  /** 设置了则校验 Authorization: Bearer <key>，不匹配返回 401。 */
  readonly requiredApiKey?: string
  /** 每个 chunk 之间的延时（毫秒），模拟真实网络。 */
  readonly delayMs?: number
  /** 自定义响应脚本；缺省用默认文本回显。 */
  readonly script?: (body: Record<string, unknown>) => MockResponse
}

export interface MockSseResult {
  readonly server: http.Server
  /** 形如 http://127.0.0.1:<port> */
  readonly url: string
  readonly requests: MockRequest[]
  close(): Promise<void>
}

/** 把对象编码为一个 SSE 事件行。 */
export function sseLine(chunk: Record<string, unknown>): string {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

/** 默认脚本：取最后一个 user 消息文本，流式回显。 */
export function defaultScript(body: Record<string, unknown>): MockResponse {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role: string; content: unknown }>) : []
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  const text =
    typeof lastUser?.content === 'string'
      ? `Mock echo: ${lastUser.content}`
      : 'Mock echo: (no user message)'
  const pieces = text.split(/(?<=。) |(?<=。)/)
  const chunks: Array<Record<string, unknown>> = pieces.map((piece, i) => ({
    id: `chatcmpl-mock-${i}`,
    choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
  }))
  chunks.push({
    id: 'chatcmpl-mock-end',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: pieces.length, total_tokens: 12 + pieces.length },
  })
  return { kind: 'stream', chunks }
}

export function startMockSse(options: MockSseOptions = {}): Promise<MockSseResult> {
  const { requiredApiKey, delayMs = 5, script = defaultScript } = options
  const requests: MockRequest[] = []

  const server = http.createServer((req, res) => {
    void (async () => {
      // 只处理 POST /chat/completions
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `Mock: not found ${req.url}`, type: 'not_found' } }))
        return
      }

      // 认证校验
      if (requiredApiKey) {
        const auth = req.headers.authorization
        if (auth !== `Bearer ${requiredApiKey}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }))
          return
        }
      }

      // 解析 body
      const raw = await readBody(req)
      let body: Record<string, unknown> | undefined
      try {
        body = JSON.parse(raw) as Record<string, unknown>
      } catch {
        body = undefined
      }
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })

      const response = script(body ?? {})
      if (response.kind === 'error') {
        res.writeHead(response.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(response.body))
        return
      }

      // SSE 流
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      for (const chunk of response.chunks) {
        res.write(sseLine(chunk))
        if (delayMs > 0) await sleep(delayMs)
      }
      res.end('data: [DONE]\n\n')
    })().catch(() => {
      res.writeHead(500)
      res.end()
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.closeAllConnections()
            server.close(() => resolveClose())
          }),
      })
    })
  })
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8')
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
