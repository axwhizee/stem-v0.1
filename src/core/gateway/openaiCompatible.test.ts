// ============================================================
// core/gateway/openaiCompatible.test.ts —— provider 实现验证
//
// 使用 mock SSE 服务器（prototype/mockSse.ts）在无真实 key 下
// 覆盖：文本流式 / usage / finish / 认证 / 错误分类 / 工具调用 /
// reasoning / 消息序列化。所有断言不依赖网络。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenAiCompatibleGateway } from './providers/openaiCompatible'
import { GatewayError, isGatewayError } from './types'
import type { LLMRequest, LLMEvent } from './types'
import { startMockSse, sseLine } from '../../../test-support/mockSse'
import type { MockResponse } from '../../../test-support/mockSse'

const baseRequest: LLMRequest = {
  model: { provider: 'opencode', id: 'test-model' },
  system: 'You are a test assistant.',
  messages: [{ role: 'user', content: 'hi' }],
}

async function collect(gateway: ReturnType<typeof createOpenAiCompatibleGateway>, request: LLMRequest): Promise<LLMEvent[]> {
  const events: LLMEvent[] = []
  for await (const event of gateway.chat(request)) events.push(event)
  return events
}

function errorFrom(events: LLMEvent[], error: unknown): GatewayError {
  assert.ok(isGatewayError(error), `expected GatewayError, got ${String(error)}`)
  assert.equal(events.length, 0, 'should not emit events before error')
  return error
}

describe('createOpenAiCompatibleGateway', () => {
  test('apiKey 可选（R13 匿名端点）：构造不抛，请求不带 Authorization', async () => {
    const mock = await startMockSse() // 无 requiredApiKey = 匿名服务
    try {
      const gateway = createOpenAiCompatibleGateway({ baseUrl: mock.url })
      await collect(gateway, baseRequest)
      assert.equal(mock.requests[0]?.headers.authorization, undefined)
    } finally {
      await mock.close()
    }
  })

  test('models 白名单：不命中 → model_not_allowed 硬错（不发请求）', async () => {
    const mock = await startMockSse()
    try {
      const gateway = createOpenAiCompatibleGateway({ baseUrl: mock.url, models: ['allowed-model'] })
      await assert.rejects(
        (async () => {
          for await (const _ of gateway.chat(baseRequest)) void _
        })(),
        (error: unknown) => isGatewayError(error) && (error as GatewayError).kind === 'model_not_allowed',
      )
      assert.equal(mock.requests.length, 0, '白名单拒绝应发生在发请求之前')
      // 命中白名单则正常流式
      const events = await collect(gateway, { ...baseRequest, model: { provider: 'x', id: 'allowed-model' } })
      assert.ok(events.some((e) => e.type === 'finish'))
    } finally {
      await mock.close()
    }
  })

  test('文本流式：产出 text-delta / usage / finish(stop)', async () => {
    const mock = await startMockSse({ requiredApiKey: 'test-key' })
    try {
      const gateway = createOpenAiCompatibleGateway({ baseUrl: mock.url, apiKey: 'test-key' })
      const events = await collect(gateway, baseRequest)

      const text = events
        .filter((e) => e.type === 'text-delta')
        .map((e) => (e as { text: string }).text)
        .join('')
      assert.ok(text.length > 0, 'should stream text')
      assert.ok(text.includes('hi'), `text should echo user input: ${text}`)

      const usage = events.find((e) => e.type === 'usage')
      assert.ok(usage && usage.type === 'usage')
      assert.ok(usage.inputTokens > 0)
      assert.ok(usage.outputTokens > 0)

      const finish = events.find((e) => e.type === 'finish')
      assert.deepEqual(finish, { type: 'finish', reason: 'stop' })
    } finally {
      await mock.close()
    }
  })

  test('请求体：system 在首位、stream_options.include_usage=true', async () => {
    const mock = await startMockSse({ requiredApiKey: 'test-key' })
    try {
      const gateway = createOpenAiCompatibleGateway({ baseUrl: mock.url, apiKey: 'test-key' })
      await collect(gateway, baseRequest)

      const body = mock.requests[0]?.body
      assert.ok(body, 'should capture request body')
      assert.equal(body.model, 'test-model', 'model 恒发裸 id（provider 不泄漏进协议体）')
      assert.equal(body.stream, true)
      assert.deepEqual((body.stream_options as Record<string, unknown>).include_usage, true)
      const messages = body.messages as Array<{ role: string; content: string }>
      assert.equal(messages[0]?.role, 'system')
      assert.equal(messages[0]?.content, 'You are a test assistant.')
      assert.equal(messages.at(-1)?.role, 'user')
      assert.equal(messages.at(-1)?.content, 'hi')
    } finally {
      await mock.close()
    }
  })

  test('认证失败：401 → GatewayError(api_error, retryable=false)', async () => {
    const mock = await startMockSse({ requiredApiKey: 'secret' })
    try {
      const gateway = createOpenAiCompatibleGateway({ baseUrl: mock.url, apiKey: 'wrong-key' })
      const events: LLMEvent[] = []
      await assert.rejects(
        (async () => {
          for await (const e of gateway.chat(baseRequest)) events.push(e)
        })(),
        (error: unknown) => {
          const e = errorFrom(events, error)
          return e.kind === 'api_error' && e.statusCode === 401 && e.retryable === false
        },
      )
    } finally {
      await mock.close()
    }
  })

  test('上下文溢出：400 context_length_exceeded → GatewayError(context_overflow)', async () => {
    const mock = await startMockSse({
      requiredApiKey: 'test-key',
      script: (): MockResponse => ({
        kind: 'error',
        status: 400,
        body: { error: { code: 'context_length_exceeded', message: 'Input exceeds context window' } },
      }),
    })
    try {
      const gateway = createOpenAiCompatibleGateway({ baseUrl: mock.url, apiKey: 'test-key' })
      const events: LLMEvent[] = []
      await assert.rejects(
        (async () => {
          for await (const e of gateway.chat(baseRequest)) events.push(e)
        })(),
        (error: unknown) => errorFrom(events, error).kind === 'context_overflow',
      )
    } finally {
      await mock.close()
    }
  })

  test('reasoning_content → reasoning-delta 事件', async () => {
    const mock = await startMockSse({
      requiredApiKey: 'test-key',
      script: (): MockResponse => ({
        kind: 'stream',
        chunks: [
          { choices: [{ index: 0, delta: { reasoning_content: 'let me think…' }, finish_reason: null }] },
          { choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } },
        ],
      }),
    })
    try {
      const gateway = createOpenAiCompatibleGateway({ baseUrl: mock.url, apiKey: 'test-key' })
      const events = await collect(gateway, baseRequest)
      const reasoning = events
        .filter((e) => e.type === 'reasoning-delta')
        .map((e) => (e as { text: string }).text)
        .join('')
      assert.equal(reasoning, 'let me think…')
    } finally {
      await mock.close()
    }
  })

  test('工具调用：增量 arguments 聚合并解析 → tool-call + finish(tool_calls)', async () => {
    const mock = await startMockSse({
      requiredApiKey: 'test-key',
      script: (): MockResponse => ({
        kind: 'stream',
        chunks: [
          {
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }, finish_reason: null }],
          },
          {
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ' "beijing"}' } }] }, finish_reason: null }],
          },
          {
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 10, completion_tokens: 4 },
          },
        ],
      }),
    })
    try {
      const gateway = createOpenAiCompatibleGateway({ baseUrl: mock.url, apiKey: 'test-key' })
      const events = await collect(gateway, baseRequest)
      const calls = events.filter((e) => e.type === 'tool-call')
      assert.equal(calls.length, 1)
      const call = calls[0]
      assert.ok(call && call.type === 'tool-call')
      assert.equal(call.id, 'call_1')
      assert.equal(call.name, 'get_weather')
      assert.deepEqual(call.input, { city: 'beijing' })
      const finish = events.find((e) => e.type === 'finish')
      assert.deepEqual(finish, { type: 'finish', reason: 'tool_calls' })
    } finally {
      await mock.close()
    }
  })

  test('消息序列化：assistant tool_calls 与 tool 结果正确回传', async () => {
    const mock = await startMockSse({ requiredApiKey: 'test-key' })
    try {
      const gateway = createOpenAiCompatibleGateway({ baseUrl: mock.url, apiKey: 'test-key' })
      const request: LLMRequest = {
        ...baseRequest,
        messages: [
          { role: 'user', content: 'what is weather in beijing?' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"beijing"}' }] },
          { role: 'tool', content: '{"temp": 22}', toolCallId: 'call_1' },
        ],
      }
      await collect(gateway, request)

      const messages = mock.requests[0]?.body?.messages as Array<Record<string, unknown>>
      assert.ok(messages, 'should capture messages')
      const assistant = messages.find((m) => m.role === 'assistant')
      const tool = messages.find((m) => m.role === 'tool')
      const toolCalls = (assistant?.tool_calls ?? []) as Array<Record<string, unknown>>
      const fn = toolCalls[0]?.function as Record<string, unknown> | undefined
      assert.equal(fn?.name, 'get_weather')
      assert.equal(tool?.tool_call_id, 'call_1')
      assert.equal(tool?.content, '{"temp": 22}')
    } finally {
      await mock.close()
    }
  })

  test('流内 error chunk → 抛出 GatewayError', async () => {
    const mock = await startMockSse({
      requiredApiKey: 'test-key',
      script: (): MockResponse => ({
        kind: 'stream',
        chunks: [
          { choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] },
          { error: { message: 'server exploded', type: 'server_error' } },
        ],
      }),
    })
    try {
      const gateway = createOpenAiCompatibleGateway({ baseUrl: mock.url, apiKey: 'test-key' })
      await assert.rejects(
        (async () => {
          for await (const _ of gateway.chat(baseRequest)) void _
        })(),
        (error: unknown) => isGatewayError(error) && (error as GatewayError).kind === 'api_error',
      )
    } finally {
      await mock.close()
    }
  })

  test('注入式 fetch：纯离线路径可流式（不发起真实 HTTP）', async () => {
    const payload =
      sseLine({ choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }] }) +
      sseLine({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }) +
      'data: [DONE]\n\n'
    const gateway = createOpenAiCompatibleGateway({
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      fetch: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        assert.ok(String(input).includes('/chat/completions'))
        assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-key')
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(payload))
            controller.close()
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }) as typeof fetch,
    })
    const events = await collect(gateway, baseRequest)
    const text = events
      .filter((e) => e.type === 'text-delta')
      .map((e) => (e as { text: string }).text)
      .join('')
    assert.equal(text, 'hello')
  })
})
