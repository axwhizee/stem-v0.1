// ============================================================
// extension/tools/websearch/dashscopeMcp.ts —— Dashscope WebSearch MCP 通路
// （websearch 入口的专用脚本：JSON-RPC over HTTP，可测纯逻辑，fetch 注入）
//
// 协议形态（对齐百炼 MCP 广场 WebSearch 服务，参考实现见 tmp/ref-tools）：
//   POST {endpoint}  Bearer <key>  jsonrpc 2.0 单帧请求
//   首调用 initialize 握手（进程内幂等），随后 tools/call bailian_web_search。
//   结果在 result.content[] 的 text 块内：JSON { pages: [{title,url,snippet,hostname}] }。
// ============================================================

/** 注入点：fetch 形状（测试注假，宿主执行 = global fetch）。 */
export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{
  ok: boolean
  status: number
  text: () => Promise<string>
}>

export interface McpCallDeps {
  readonly fetch: FetchLike
  readonly endpoint: string
  readonly apiKey: string
}

interface JsonRpcEnvelope<T> {
  readonly result?: T
  readonly error?: { readonly code: number; readonly message: string }
}

export interface McpContentBlock {
  readonly type: string
  readonly text?: string
}

export interface McpCallResult {
  readonly content?: readonly McpContentBlock[]
  readonly isError?: boolean
}

/** 单帧 JSON-RPC 调用（HTTP 层与协议层错误统一抛 Error，工具层兜成执行失败文本）。 */
export async function mcpCall<T>(deps: McpCallDeps, method: string, params: unknown): Promise<T> {
  const res = await deps.fetch(deps.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${deps.apiKey}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const body = JSON.parse(await res.text()) as JsonRpcEnvelope<T>
  if (body.error) throw new Error(`MCP error ${body.error?.code}: ${body.error?.message}`)
  if (body.result === undefined) throw new Error('MCP 响应缺少 result')
  return body.result
}

/** MCP initialize 握手（每进程一次；WebSearch 服务无状态，握手仅作协议要求）。 */
let initialized = false
export async function ensureMcpInitialized(deps: McpCallDeps): Promise<void> {
  if (initialized) return
  await mcpCall(deps, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'stem', version: '1.0' },
  })
  initialized = true
}

/** 测试支持：重置握手状态。 */
export function resetMcpInit(): void {
  initialized = false
}

/** 调 bailian_web_search 取原始 text 块（首个非空）。 */
export async function callBailianWebSearch(
  deps: McpCallDeps,
  query: string,
  count: number,
): Promise<string> {
  await ensureMcpInitialized(deps)
  const result = await mcpCall<McpCallResult>(deps, 'tools/call', {
    name: 'bailian_web_search',
    arguments: { query, count },
  })
  for (const block of result.content ?? []) {
    if (block.type === 'text' && block.text) return block.text
  }
  return JSON.stringify(result)
}

// ---------- 结果格式化（行式压缩，控 token） ----------

interface AliyunPage {
  readonly title?: string
  readonly url?: string
  readonly snippet?: string
  readonly hostname?: string
}

function clean(s: string | undefined, max = 500): string {
  if (!s) return ''
  const t = s.replace(/[\n\r]+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** 文本块 → 编号列表（解析失败原样返回，保证不吞信息）。 */
export function formatAliyunPages(text: string): string {
  let data: { pages?: AliyunPage[] }
  try {
    data = JSON.parse(text) as { pages?: AliyunPage[] }
  } catch {
    return text
  }
  const pages = data.pages
  if (!pages || pages.length === 0) return '未找到相关结果。'
  return pages
    .map((p, i) => {
      const parts = [`${i + 1}. ${p.title ?? '(无标题)'}`, `   URL: ${p.url ?? ''}`]
      if (p.hostname) parts.push(`   来源: ${p.hostname}`)
      const snippet = clean(p.snippet)
      if (snippet) parts.push(`   ${snippet}`)
      return parts.join('\n')
    })
    .join('\n\n')
}
