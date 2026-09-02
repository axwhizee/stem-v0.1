// ============================================================
// extension/tools/websearch/websearch.test.ts —— MCP 通路与工具行为（假 fetch 注入）
// ============================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatAliyunPages, mcpCall, resetMcpInit, type FetchLike } from './dashscopeMcp'
import { createWebSearchTool } from './websearch'
import type { ToolContext } from '../../../src/core/tools'

const CTX = { agentId: 'a1', spaceId: 's1' } as ToolContext

/** MCP 帧假服务：按 method 路由，记录请求序。 */
function fakeMcp(opts: { pages?: unknown; failAt?: 'http' | 'rpc' } = {}): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = []
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { method: string }
    calls.push(body.method)
    if (opts.failAt === 'http') return { ok: false, status: 403, text: async () => 'forbidden' }
    if (opts.failAt === 'rpc') return { ok: true, status: 200, text: async () => JSON.stringify({ error: { code: -32, message: 'bad' } }) }
    if (body.method === 'initialize') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ result: { protocolVersion: '2024-11-05' } }) }
    }
    const payload = JSON.stringify({ pages: opts.pages ?? [] })
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ result: { content: [{ type: 'text', text: payload }] } }),
    }
  }
  return { fetch, calls }
}

test('formatAliyunPages：编号列表 + 无结果 + 非 JSON 原样', () => {
  const text = formatAliyunPages(JSON.stringify({
    pages: [
      { title: '标题一', url: 'https://a.dev', snippet: '摘要一', hostname: 'a.dev' },
      { title: '标题二', url: 'https://b.dev' },
    ],
  }))
  assert.match(text, /1\. 标题一/)
  assert.match(text, /来源: a\.dev/)
  assert.match(text, /2\. 标题二/)
  assert.equal(formatAliyunPages('{"pages":[]}'), '未找到相关结果。')
  assert.equal(formatAliyunPages('not-json'), 'not-json')
})

test('mcpCall：HTTP 错误与协议错误统一抛 Error', async () => {
  const base = { endpoint: 'https://mcp.test', apiKey: 'k' }
  const http = { ...base, fetch: fakeMcp({ failAt: 'http' }).fetch }
  await assert.rejects(() => mcpCall(http, 'x', {}), /HTTP 403/)
  const rpc = { ...base, fetch: fakeMcp({ failAt: 'rpc' }).fetch }
  await assert.rejects(() => mcpCall(rpc, 'x', {}), /MCP error -32/)
})

test('websearch：initialize 握手幂等 + tools/call 携带参数', async () => {
  resetMcpInit()
  const mcp = fakeMcp({ pages: [{ title: 'T', url: 'https://t.dev', snippet: 'S', hostname: 't.dev' }] })
  const tool = createWebSearchTool({ fetch: mcp.fetch, apiKey: 'k-test' })
  const r = await tool.execute({ query: '天气', count: 3 }, CTX)
  assert.match(r.text, /1\. T/)
  await tool.execute({ query: '再次', count: 2 }, CTX)
  assert.deepEqual(mcp.calls, ['initialize', 'tools/call', 'tools/call']) // 第二次不再握手
})

test('websearch：count 夹取（≤20 ≥1）与非法 query', async () => {
  resetMcpInit()
  let seenCount: unknown
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { method: string; params?: { arguments?: { count?: number } } }
    if (body.method === 'tools/call') seenCount = body.params?.arguments?.count
    return { ok: true, status: 200, text: async () => JSON.stringify({ result: { content: [{ type: 'text', text: '{"pages":[]}' }] } }) }
  }
  const tool = createWebSearchTool({ fetch, apiKey: 'k' })
  await tool.execute({ query: 'x', count: 999 }, CTX)
  assert.equal(seenCount, 20)
  await tool.execute({ query: 'x', count: -4 }, CTX)
  assert.equal(seenCount, 1)
  assert.match((await tool.execute({ query: '  ' }, CTX)).text, /query 不能为空/)
})

test('websearch：密钥未配置 → 可行动错误文本（不抛栈、fail-soft）', async () => {
  const saved = process.env.ALIBABA_API_KEY
  delete process.env.ALIBABA_API_KEY
  try {
    const tool = createWebSearchTool({ fetch: fakeMcp().fetch })
    const r = await tool.execute({ query: 'x' }, CTX)
    assert.match(r.text, /ALIBABA_API_KEY 未设置/)
  } finally {
    if (saved !== undefined) process.env.ALIBABA_API_KEY = saved
  }
})

test('websearch：调用异常兜成失败文本', async () => {
  resetMcpInit()
  const tool = createWebSearchTool({ fetch: async () => { throw new Error('network down') }, apiKey: 'k' })
  assert.match((await tool.execute({ query: 'x' }, CTX)).text, /调用失败：network down/)
})
