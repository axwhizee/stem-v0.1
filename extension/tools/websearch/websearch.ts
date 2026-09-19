// ============================================================
// extension/tools/websearch/websearch.ts —— 网页搜索工具（kind=extension）
//
// 后端 = 阿里云百炼 WebSearch（Dashscope MCP 端点，通路在 ./dashscopeMcp.ts）。
// 密钥治理：值只走环境变量 ALIBABA_API_KEY（与 providers.alibaba.key_env 同
// 账号同变量），源码/config/日志零明文；未设置 = 用到时才回可行动错误文本。
// 对外操作面与 bash 同权级：静态权限、无黑名单，超时兜底。
// ============================================================

import type { ToolCapability } from '../../../src/core/tools'
import { callBailianWebSearch, formatAliyunPages, type FetchLike } from './dashscopeMcp'

const DEFAULT_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp'
const DEFAULT_TIMEOUT_MS = 30_000

export interface WebSearchDeps {
  readonly fetch?: FetchLike
  readonly endpoint?: string
  /** 显式密钥（缺省 execute 时读 process.env.ALIBABA_API_KEY——测试注入点）。 */
  readonly apiKey?: string
}

/** 测试可注入 deps；生产经 default 工厂（loader 注入 projectRoot，本工具不需要）。 */
export function createWebSearchTool(deps: WebSearchDeps = {}): ToolCapability {
  const fetchImpl: FetchLike =
    deps.fetch ??
    ((url, init) =>
      // global fetch（node 宿主直用；extension 层不受 core 零平台依赖约束）
      globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) }) as unknown as Promise<{
        ok: boolean
        status: number
        text: () => Promise<string>
      }>)

  return {
    id: 'websearch',
    description:
      '搜索网页（阿里云百炼 WebSearch），返回编号结果列表（标题/URL/来源/摘要）。适合实时信息、事实核验、开放域资料收集。查询用具体关键词，中英文皆可。',
    kind: 'extension',
    registerAccess: 'allow', // 自述推荐值；实际注册声明以 config.extensions.tools 点名权限词为准
    category: 'business',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        count: { type: 'number', description: '结果数，默认 5，最大 20' },
      },
      required: ['query'],
    },
    execute: async (input) => {
      const { query, count } = (input ?? {}) as { query?: string; count?: number }
      if (!query || query.trim() === '') return { text: '参数错误：query 不能为空' }
      const apiKey = deps.apiKey ?? process.env.ALIBABA_API_KEY
      if (!apiKey) {
        return { text: 'websearch 不可用：环境变量 ALIBABA_API_KEY 未设置（宿主启动前 export 或容器 -e 注入）' }
      }
      const n = Math.min(Math.max(Math.floor(count ?? 5), 1), 20)
      try {
        const text = await callBailianWebSearch(
          { fetch: fetchImpl, endpoint: deps.endpoint ?? DEFAULT_ENDPOINT, apiKey },
          query.trim(),
          n,
        )
        return { text: formatAliyunPages(text) }
      } catch (cause) {
        return { text: `websearch 调用失败：${cause instanceof Error ? cause.message : String(cause)}` }
      }
    },
  }
}

/** 矩阵入口约定：default = 工厂（loader 注入 projectRoot，本工具无空间依赖故忽略）。 */
export default function createWebSearchToolForSpace(): ToolCapability {
  return createWebSearchTool()
}
