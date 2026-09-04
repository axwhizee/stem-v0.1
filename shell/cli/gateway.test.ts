// ============================================================
// shell/cli/gateway.test.ts —— provider 网关装配 + 路由（S6/R1 宿主门面）
//
// 验收：零兜底两段式（启动 warn 点名不印值 / 用到才硬错）、
// mockSse 作为普通匿名 provider（冒烟通道）、白名单贯通执行。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildGateway, providerFetch } from './gateway'
import { startMockSse } from './mockSse'
import { isGatewayError, type GatewayError, type LLMEvent, type LLMRequest } from '../../src/core/gateway'
import { parseConfigText } from '../../src/core/config'

function req(provider: string, id = 'some-model'): LLMRequest {
  return { model: { provider, id }, messages: [{ role: 'user', content: 'hi' }] }
}

async function collect(gateway: ReturnType<typeof buildGateway>['gateway'], request: LLMRequest): Promise<LLMEvent[]> {
  const events: LLMEvent[] = []
  for await (const event of gateway.chat(request)) events.push(event)
  return events
}

describe('buildGateway（config 驱动 + provider 路由）', () => {
  test('两段式第一段：key_env 未命中 → 启动 warn 点名 env 名（不印值）+ 不接通', () => {
    const config = parseConfigText(
      '{ "providers": { "a": { "base_url": "https://a.test/v1", "key_env": "A_KEY" }, "b": { "base_url": "https://b.test/v1", "key_env": "B_KEY" } } }',
    )
    const { wired, warnings } = buildGateway(config, { A_KEY: 'sk-super-secret' })
    assert.deepEqual(wired, ['a'])
    assert.equal(warnings.length, 1)
    assert.ok(warnings[0]?.includes('$B_KEY'), 'warn 点名 env 变量名')
    assert.ok(!warnings[0]?.includes('sk-super-secret'), 'warn 不印密钥值')
  })

  test('两段式第二段：未接通/未注册的 provider 用到才硬错（文案可行动）', async () => {
    const config = parseConfigText('{ "providers": { "b": { "base_url": "https://b.test/v1", "key_env": "B_KEY" } } }')
    const { gateway } = buildGateway(config, {})
    await assert.rejects(
      () => collect(gateway, req('b')),
      (e: unknown) => {
        const err = e as GatewayError
        return isGatewayError(err) && err.kind === 'provider_unwired' && err.message.includes('export B_KEY=<key>')
      },
    )
    await assert.rejects(
      () => collect(gateway, req('ghost')),
      (e: unknown) => {
        const err = e as GatewayError
        return isGatewayError(err) && err.kind === 'provider_unwired' && err.message.includes('未在 config providers 注册')
      },
    )
  })

  test('models 白名单贯通：config → 网关实例，命中放行、不命中 model_not_allowed', async () => {
    const mock = await startMockSse()
    try {
      const config = parseConfigText(`{ "providers": { "mock": { "base_url": "${mock.url}", "models": ["allowed"] } } }`)
      const { gateway } = buildGateway(config, {})
      await assert.rejects(
        () => collect(gateway, req('mock', 'forbidden')),
        (e: unknown) => isGatewayError(e) && (e as GatewayError).kind === 'model_not_allowed',
      )
      const events = await collect(gateway, req('mock', 'allowed'))
      assert.ok(events.some((event) => event.type === 'finish'))
      assert.equal(mock.requests.length, 1, '白名单拒绝不触网')
    } finally {
      await mock.close()
    }
  })

  test('mockSse 作为普通匿名 provider（R13 无 key_env 形态）：无 Authorization 直通流式', async () => {
    const mock = await startMockSse()
    try {
      const config = parseConfigText(`{ "providers": { "mock": { "base_url": "${mock.url}" } } }`)
      const { gateway, wired, warnings } = buildGateway(config, {})
      assert.deepEqual(wired, ['mock'])
      assert.deepEqual(warnings, [], '匿名端点无 key_env 不告警')
      const events = await collect(gateway, req('mock'))
      const text = events
        .filter((event) => event.type === 'text-delta')
        .map((event) => (event as { text: string }).text)
        .join('')
      assert.ok(text.includes('Mock echo: hi'), `默认脚本回显（实际：${text}）`)
      assert.equal(mock.requests[0]?.headers.authorization, undefined, '匿名请求不发 Authorization 头')
      assert.ok(mock.requests[0]?.url.endsWith('/chat/completions'), 'baseUrl 拼接协议端点')
    } finally {
      await mock.close()
    }
  })
})

describe('providerFetch（opencode 运营适配关在 shell 宿主层，core 零感知）', () => {
  function captureHeaders(baseUrl: string): Record<string, string> {
    const original = globalThis.fetch
    let captured: Record<string, string> | undefined
    globalThis.fetch = ((_, init?: RequestInit) => {
      captured = init?.headers as Record<string, string>
      return Promise.reject(new Error('captured'))
    }) as typeof fetch
    try {
      // reject 是捕获手段——同步 try 接不住 promise，挂空 catch 防 unhandled。
      providerFetch(baseUrl)('https://x.test/v1/chat/completions', { headers: { 'Content-Type': 'application/json' } }).catch(() => {})
    } finally {
      globalThis.fetch = original
    }
    assert.ok(captured, 'headers 已捕获')
    return captured
  }

  test('opencode.ai 域：session 头 + stem UA 齐备，原有头保留', () => {
    const h = captureHeaders('https://opencode.ai/zen/go/v1')
    assert.match(h['x-opencode-session'] ?? '', /^[0-9a-f-]{36}$/, '进程级 uuid 会话 id')
    assert.match(h['User-Agent'] ?? '', /^stem\//, 'UA 不再是裸 Node fetch')
    assert.equal(h['Content-Type'], 'application/json', 'core 注入的基础头不被覆盖')
  })

  test('非 opencode 域：只补 UA，不发厂商头；进程 id 跨调用稳定', () => {
    const h = captureHeaders('https://api.tavily.com/mcp')
    assert.equal(h['x-opencode-session'], undefined)
    assert.match(h['User-Agent'] ?? '', /^stem\//)
    const again = captureHeaders('https://opencode.ai/zen/go/v1')
    const first = captureHeaders('https://opencode.ai/zen/go/v1')
    assert.equal(again['x-opencode-session'], first['x-opencode-session'], '同进程稳定（stable per conversation）')
  })
})
