// ============================================================
// extension/tools/mcp/mcp.ts —— 通用 MCP 机制（机制在 extension）
//
// 定义住 stem 空间 `.stem/mcp.jsonc`，规范格式 = 主流 harness 的
// `mcpServers`（stdio：command/args/env；http/sse：type/url/headers）。
// init：读清单 → 连接各服务器 → tools/list → 投影为 ToolCapability
// 经 registerMore 入 drain 队列。不为远程工具落 stem 源文件。
// ============================================================

import { readFile } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'

import type { ToolCapability, ToolInitContext, ToolAccess, ToolParametersSchema } from '../../../src/core/tools'

/** 常见 harness mcpServers 单条定义（兼容 stem 可选扩展字段）。 */
export interface McpServerDef {
  /** http | sse | stdio（缺省：有 url = http，否则 stdio）。 */
  readonly type?: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  /** stem 扩展：投影工具注册声明（缺省用机制工具的 birth）。 */
  readonly access?: ToolAccess
  readonly enabled?: boolean
}

export interface McpServersFile {
  readonly mcpServers?: Readonly<Record<string, McpServerDef>>
  /** opencode 系次要兼容。 */
  readonly mcp?: {
    readonly servers?: Readonly<Record<string, McpServerDef>>
    readonly [name: string]: unknown
  }
}

type JsonRpcResp = {
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string }
}

function resolveEnv(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const m = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)
  if (m) return process.env[m[1]!]
  return value
}

function normalizeServers(file: McpServersFile): Record<string, McpServerDef> {
  const out: Record<string, McpServerDef> = {}
  if (file.mcpServers !== undefined) {
    for (const [name, def] of Object.entries(file.mcpServers)) out[name] = def
  }
  const mcp = file.mcp
  if (mcp?.servers !== undefined) {
    for (const [name, def] of Object.entries(mcp.servers)) {
      if (out[name] === undefined) out[name] = def
    }
  }
  return out
}

function kindOf(def: McpServerDef): 'http' | 'stdio' {
  const t = (def.type ?? '').toLowerCase()
  if (t === 'stdio' || t === 'local') return 'stdio'
  if (def.url !== undefined && def.url !== '') return 'http'
  return 'stdio'
}

/** HTTP JSON-RPC 单帧（initialize 幂等 + method）。 */
class HttpMcpSession {
  private initialized = false
  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
  ) {}

  async call<T>(method: string, params: unknown): Promise<T> {
    if (!this.initialized && method !== 'initialize') {
      await this.call('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'stem-mcp', version: '0.1.0' },
      })
      this.initialized = true
    }
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`)
    const body = JSON.parse(text) as JsonRpcResp
    if (body.error) throw new Error(`MCP error ${body.error.code}: ${body.error.message}`)
    return body.result as T
  }
}

/** stdio JSON-RPC（newline-delimited）。 */
class StdioMcpSession {
  private seq = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private buffer = ''
  private initialized = false
  private closed = false

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      let idx = this.buffer.indexOf('\n')
      while (idx >= 0) {
        const line = this.buffer.slice(0, idx).trim()
        this.buffer = this.buffer.slice(idx + 1)
        idx = this.buffer.indexOf('\n')
        if (line === '') continue
        try {
          const msg = JSON.parse(line) as JsonRpcResp & { id?: number }
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!
            this.pending.delete(msg.id)
            if (msg.error) p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`))
            else p.resolve(msg.result)
          }
        } catch {
          /* 忽略非 JSON 行 */
        }
      }
    })
    child.on('exit', () => {
      this.closed = true
      for (const [, p] of this.pending) p.reject(new Error('MCP stdio 进程已退出'))
      this.pending.clear()
    })
  }

  async call<T>(method: string, params: unknown): Promise<T> {
    if (this.closed) throw new Error('MCP stdio 会话已关闭')
    if (!this.initialized && method !== 'initialize') {
      await this.call('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'stem-mcp', version: '0.1.0' },
      })
      this.initialized = true
    }
    const id = this.seq++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  dispose(): void {
    try {
      this.child.kill()
    } catch {
      /* 已退出 */
    }
  }
}

type McpSession = HttpMcpSession | StdioMcpSession

async function openSession(def: McpServerDef): Promise<McpSession> {
  if (kindOf(def) === 'http') {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(def.headers ?? {})) {
      const resolved = resolveEnv(v)
      if (resolved !== undefined) headers[k] = resolved
    }
    return new HttpMcpSession(def.url!, headers)
  }
  const cmd = def.command
  if (cmd === undefined || cmd === '') throw new Error('stdio MCP 缺少 command')
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  for (const [k, v] of Object.entries(def.env ?? {})) {
    const resolved = resolveEnv(v)
    if (resolved !== undefined) env[k] = resolved
  }
  const child = spawn(cmd, [...(def.args ?? [])], {
    env,
    ...(def.cwd !== undefined ? { cwd: def.cwd } : {}),
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams
  return new StdioMcpSession(child)
}

interface McpToolListResult {
  readonly tools?: readonly {
    readonly name: string
    readonly description?: string
    readonly inputSchema?: Record<string, unknown>
  }[]
}

const sessions: McpSession[] = []

/** 机制工具本身：init 读 .stem/mcp.jsonc 并投影远程工具。 */
function createMcpBootstrapTool(): ToolCapability {
  return {
    id: 'mcp',
    description:
      '通用 MCP 机制（定义住 .stem/mcp.jsonc，格式 = mcpServers）。初始化时连接服务器并把远程工具投影入表；本工具自身一般不被模型直接调用。',
    kind: 'extension',
    category: 'system',
    birth: 'ignore',
    parameters: { type: 'object', properties: {} },
    init: async (ctx: ToolInitContext) => {
      const root = ctx.projectRoot ?? process.cwd()
      const file = join(root, '.stem', 'mcp.jsonc')
      let text: string | undefined
      if (ctx.fs !== undefined) {
        text = await ctx.fs.readText(file).catch(() => undefined)
      } else {
        text = await readFile(file, 'utf8').catch(() => undefined)
      }
      if (text === undefined) return
      let parsed: McpServersFile = {}
      try {
        parsed = (parseJsonc(text) ?? {}) as McpServersFile
      } catch {
        ctx.log?.log({
          type: 'kernel.orphan.error',
          at: Date.now(),
          site: 'extension.mcp.init',
          error: '.stem/mcp.jsonc 解析失败',
        })
        return
      }
      const servers = normalizeServers(parsed)
      for (const [serverName, def] of Object.entries(servers)) {
        if (def.enabled === false) continue
        try {
          const session = await openSession(def)
          sessions.push(session)
          const list = await session.call<McpToolListResult>('tools/list', {})
          const access = def.access ?? 'ignore'
          for (const t of list.tools ?? []) {
            const toolId = `mcp_${serverName}_${t.name}`
            const remote = t
            const sess = session
            ctx.registerMore({
              id: toolId,
              description: remote.description ?? `MCP ${serverName}/${remote.name}`,
              kind: 'extension',
              category: 'business',
              birth: access,
              accessKey: toolId,
              parameters: {
                type: 'object',
                properties: (remote.inputSchema?.properties ?? {}) as ToolParametersSchema['properties'],
                ...(Array.isArray(remote.inputSchema?.required)
                  ? { required: remote.inputSchema!.required as string[] }
                  : {}),
              },
              execute: async (input) => {
                const result = await (sess as McpSession).call<{ content?: readonly { type?: string; text?: string }[] }>(
                  'tools/call',
                  { name: remote.name, arguments: input ?? {} },
                )
                const texts = (result.content ?? [])
                  .filter((c) => c.type === 'text' && typeof c.text === 'string')
                  .map((c) => c.text as string)
                return { text: texts.join('\n') || JSON.stringify(result) }
              },
            })
          }
        } catch (cause) {
          ctx.log?.log({
            type: 'kernel.orphan.error',
            at: Date.now(),
            site: `extension.mcp.init(${serverName})`,
            error: cause instanceof Error ? cause.message : String(cause),
          })
        }
      }
    },
    execute: async () => ({
      text: 'MCP 机制就绪态在 init 期组装；远程工具以 mcp_<服务器>_<工具名> 入表。定义见 .stem/mcp.jsonc（mcpServers 格式）。',
    }),
  }
}

export default function createMcpTool(_projectRoot?: string): ToolCapability {
  return createMcpBootstrapTool()
}
