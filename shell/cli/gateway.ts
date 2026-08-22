// ============================================================
// shell/cli/gateway.ts —— 网关构建（真实 go/zen 或 mock SSE）
// ============================================================

import { createOpencodeGateway, type ModelGateway } from '../../src/core/gateway'
import { startMockSse, defaultScript, type MockResponse } from '../../test-support/mockSse'

const DEFAULT_MODEL = 'deepseek-v4-flash'

/** 构建网关：有 OPENCODE_API_KEY 走真实网关，否则 mock SSE。 */
export async function buildGateway(modelId?: string): Promise<{ gateway: ModelGateway; source: string }> {
  const apiKey = process.env.OPENCODE_API_KEY
  if (apiKey) {
    return {
      gateway: createOpencodeGateway({ apiKey }),
      source: `real go/zen (model=${process.env.OPENCODE_MODEL ?? modelId ?? DEFAULT_MODEL})`,
    }
  }
  // mock 模式：按 system 区分角色，按轮次推进（创建→等待→汇报）。
  const systemRounds = new Map<string, number>()
  const mock = await startMockSse({
    requiredApiKey: 'test-key',
    delayMs: 6,
    script: (body): MockResponse => {
      const messages = (body.messages ?? []) as Array<{ role: string; content: unknown }>
      const system = typeof messages[0]?.content === 'string' ? messages[0].content : ''
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')
      const text = typeof lastUser?.content === 'string' ? lastUser.content : ''
      const hasToolResult = messages.some((m) => m.role === 'tool')
      const tools = (body.tools ?? []) as Array<{ function?: { name: string } }>

      const key = system.includes('creator-sys') ? 'creator' : system.includes('tool-sys') ? 'tool' : 'other'
      const round = systemRounds.get(key) ?? 0
      systemRounds.set(key, round + 1)

      if (key === 'creator') {
        if (round === 0) {
          return toolCall('agent_instantiate', { classId: 'tool-agent', userPrompt: '请读取当前时间，然后把时间告诉我。' })
        }
        if (round === 1) {
          const lastTool = [...messages].reverse().find((m) => m.role === 'tool')
          const toolText = typeof lastTool?.content === 'string' ? lastTool.content : ''
          const created = /已创建 agent (\w+)/.exec(toolText)
          return toolCall('context_wait', { agentId: created?.[1] ?? 'sub-0' })
        }
        return streamText('（mock）子agent 报告当前时间是 12:00:00')
      }
      if (key === 'tool') {
        if (round === 0) return toolCall('oc_get_time', {})
        return streamText('（mock）当前时间是 12:00:00')
      }

      if (tools.some((t) => t.function?.name === 'oc_echo') && /echo|回显/i.test(text) && !hasToolResult) {
        return toolCall('oc_echo', { text })
      }
      if (hasToolResult) {
        const lastTool = [...messages].reverse().find((m) => m.role === 'tool')
        const toolText = typeof lastTool?.content === 'string' ? lastTool.content : ''
        return streamText(`（mock）工具已执行，结果：${toolText}`)
      }
      return defaultScript(body)
    },
  })
  return {
    gateway: createOpencodeGateway({ server: mock.url, apiKey: 'test-key' }),
    source: `mock SSE (${mock.url})`,
  }
}

function splitText(text: string): Array<Record<string, unknown>> {
  return text.split(/(?<=。) |(?<=。)/).map((piece, i) => ({
    id: `chatcmpl-mock-${i}`,
    choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
  }))
}

function streamText(text: string): MockResponse {
  return {
    kind: 'stream',
    chunks: [
      ...splitText(text),
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 8 } },
    ],
  }
}

function toolCall(name: string, args: Record<string, unknown>): MockResponse {
  return {
    kind: 'stream',
    chunks: [
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: `call_mock_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 15, completion_tokens: 4 } },
    ],
  }
}