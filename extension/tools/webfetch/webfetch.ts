// ============================================================
// extension/tools/webfetch/webfetch.ts —— 网页抓取工具（kind=extension）
//
// 参考 opencode webfetch 简化：全局 fetch + 超时/大小/截断三护栏 +
// text/markdown/html 三形态（markdown 优先请求原生、退化自实现转换）。
// 零密钥、零配置；与 bash 同为对外操作面（无 ask，机制限事故半径）。
// ============================================================

import type { ToolCapability } from '../../../src/core/tools'
import { htmlToMarkdown, htmlToText } from './htmlExtract'

export interface WebFetchResponse {
  readonly status: number
  readonly url?: string
  readonly headers: { readonly get: (name: string) => string | null }
  readonly text: () => Promise<string>
}

export type WebFetchLike = (url: string, init: Record<string, unknown>) => Promise<WebFetchResponse>

const DEFAULT_TIMEOUT_SEC = 30
const MAX_TIMEOUT_SEC = 120
const DEFAULT_MAX_CHARS = 20_000
const MAX_FETCH_BYTES = 4 * 1024 * 1024 // 转换前护栏（防超大页拖死内存）
const MAX_REDIRECTS = 5
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 stem-webfetch/1.0'

export interface WebFetchDeps {
  readonly fetch?: WebFetchLike
}

function acceptHeader(format: string): string {
  if (format === 'markdown') {
    // 原生 markdown 优先（部分服务直出），退化 html。
    return 'text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1'
  }
  if (format === 'text') return 'text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1'
  return 'text/html;q=1.0, */*;q=0.5'
}

/** 测试可注入 deps；生产经 default 工厂。 */
export function createWebFetchTool(deps: WebFetchDeps = {}): ToolCapability {
  const fetchImpl: WebFetchLike =
    deps.fetch ??
    ((url, init) => globalThis.fetch(url, init) as unknown as Promise<WebFetchResponse>)

  return {
    id: 'webfetch',
    description:
      '抓取指定 URL 的网页内容（默认转 markdown 正文）。用于阅读搜索结果指向的页面、文档站、README 等。需要登录/纯 JS 渲染的页面可能拿不到正文。',
    kind: 'extension',
    registerAccess: 'allow', // 自述推荐值；实际注册声明以 config.extensions.tools 点名权限词为准
    category: 'business',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整 URL（http/https）' },
        format: { type: 'string', description: 'text | markdown | html，默认 markdown' },
        timeout: { type: 'number', description: '超时秒数（默认 30，上限 120）' },
        maxChars: { type: 'number', description: '输出字符上限（默认 20000，上限 100000）' },
      },
      required: ['url'],
    },
    execute: async (input) => {
      const { url, format, timeout, maxChars } = (input ?? {}) as {
        url?: string
        format?: string
        timeout?: number
        maxChars?: number
      }
      if (!url || !/^https?:\/\//i.test(url.trim())) {
        return { text: '参数错误：url 必须是 http(s) 完整地址' }
      }
      const fmt = format === 'text' || format === 'html' ? format : 'markdown'
      const limit = Math.min(Math.max(Math.floor(maxChars ?? DEFAULT_MAX_CHARS), 500), 100_000)
      const timeoutMs = Math.min(Math.max(timeout ?? DEFAULT_TIMEOUT_SEC, 1), MAX_TIMEOUT_SEC) * 1000

      try {
        // 手动重定向（限次数防环；node fetch 默认 20 跳过多）。
        let target = url.trim()
        let res: WebFetchResponse | undefined
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          res = await fetchImpl(target, {
            headers: { Accept: acceptHeader(fmt), 'User-Agent': USER_AGENT },
            redirect: 'manual',
            signal: AbortSignal.timeout(timeoutMs),
          })
          const location = res.headers.get('location')
          if (res.status >= 300 && res.status < 400 && location) {
            target = new URL(location, target).toString()
            continue
          }
          break
        }
        if (!res) return { text: '抓取失败：无响应' }
        if (res.status >= 400) {
          return { text: `抓取失败：HTTP ${res.status}（${target}）` }
        }
        const raw = (await res.text()).slice(0, MAX_FETCH_BYTES)
        const contentType = (res.headers.get('content-type') ?? '').toLowerCase()

        let out: string
        if (fmt === 'html' || contentType.includes('html')) {
          out = fmt === 'text' ? htmlToText(raw) : fmt === 'html' ? raw : htmlToMarkdown(raw)
        } else if (/^text\//.test(contentType) || contentType.includes('json') || contentType.includes('xml') || contentType === '') {
          out = raw // 原生文本族（含直出的 markdown）
        } else {
          return { text: `不支持的响应类型：${contentType || '未知 content-type'}（仅文本/html/markdown；二进制不返回内容）` }
        }
        if (out.length > limit) {
          out = `${out.slice(0, limit)}\n…（截断：原长 ${out.length} 字符，可调 maxChars≤100000）`
        }
        const finalUrl = res.url ?? target
        return { text: out === '' ? '（页面无可见文本）' : `${out}\n\n—— 抓取于 ${finalUrl}` }
      } catch (cause) {
        const msg = cause instanceof Error ? (cause.name === 'TimeoutError' ? `超时（>${timeoutSecLabel(timeoutMs)}）` : cause.message) : String(cause)
        return { text: `抓取失败：${msg}` }
      }
    },
  }
}

function timeoutSecLabel(ms: number): string {
  return `${Math.round(ms / 1000)}s`
}

/** 矩阵入口约定：default = 工厂（loader 注入 projectRoot，本工具无空间依赖故忽略）。 */
export default function createWebFetchToolForSpace(): ToolCapability {
  return createWebFetchTool()
}
