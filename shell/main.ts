// ============================================================
// shell/main.ts —— 临时 shell 层（core 调试/检验用）
//
// 面板角色：注册为 user0（接入总线 + 邮局，与 agent 一视同仁）。
// 用户输入 → bus.send → 邮局 → 送信 → AgentRuntime 处理 → 自动寄信
// → user0 信箱收信汇总 → 本 shell 展示。
//
// 运行：
//   npm run shell
//   OPENCODE_API_KEY=<key> npm run shell     # 走真实 go/zen
//
// 命令：
//   直接输入 → 与当前 agent 对话
//   /new <classId> [name] [userPrompt]  新建实例（userPrompt 默认自我介绍）
//   /use <agentId>      切换当前实例
//   /agents             列出实例
//   /templates          列出模板
//   /tools              列出已注册工具
//   /source             显示 gateway 来源
//   /help | /exit
// ============================================================

import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import {
  AgentKernel,
  makeAgentClassID,
  makeAgentID,
  makeAgentSpaceID,
  BUILTIN_TEMPLATES,
  USER_ID,
  type AgentID,
  type AgentClassID,
} from '../src/core/kernel'
import { createOpencodeGateway, GatewayError, isGatewayError, type ModelGateway } from '../src/core/gateway'
import { DefaultToolCapabilityRegistry, type ToolCapability } from '../src/core/tools'
import { startMockSse, defaultScript, type MockResponse } from '../test-support/mockSse'
import { userDeliveryQueue } from '../test-support/kernelHarness'
import type { UserDelivery } from '../src/core/context'

const DEFAULT_MODEL = 'deepseek-v4-flash'
const DEFAULT_PROJECT = '/workspace/stem-demo'
const DEFAULT_USER_PROMPT = '你好，请做一个简短的自我介绍。'

interface ShellState {
  kernel: AgentKernel
  currentAgentId: AgentID
  source: string
  deliveries: ReturnType<typeof userDeliveryQueue>
  /** 流式输出状态（避免收信重复打印）。 */
  display: { streamedAny: boolean }
}

/** 演示业务工具：回显文本。 */
const ocEcho: ToolCapability = {
  id: 'oc_echo',
  description: '回显一段文本（原样返回）。',
  permission: 'normal',
  category: 'business',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: '要回显的文本' } },
    required: ['text'],
  },
  execute: (input) => ({ text: `Echo: ${(input as { text: string }).text}` }),
}

/** 演示业务工具：返回当前 UTC 时间。 */
const ocGetTime: ToolCapability = {
  id: 'oc_get_time',
  description: '获取当前 UTC 时间。',
  permission: 'normal',
  category: 'business',
  parameters: { type: 'object', properties: {} },
  execute: () => ({ text: `当前 UTC 时间: ${new Date().toISOString()}` }),
}

async function buildGateway(): Promise<{ gateway: ModelGateway; source: string }> {
  const apiKey = process.env.OPENCODE_API_KEY
  if (apiKey) {
    return { gateway: createOpencodeGateway({ apiKey }), source: `real go/zen (model=${process.env.OPENCODE_MODEL ?? DEFAULT_MODEL})` }
  }
  // mock 模式：识别 echo 请求 → 返回 tool_call 演示工具轮。
  const mock = await startMockSse({
    requiredApiKey: 'test-key',
    delayMs: 6,
    script: (body): MockResponse => {
      const messages = (body.messages ?? []) as Array<{ role: string; content: unknown }>
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')
      const text = typeof lastUser?.content === 'string' ? lastUser.content : ''
      const hasToolResult = messages.some((m) => m.role === 'tool')
      const tools = (body.tools ?? []) as Array<{ function?: { name: string } }>

      if (tools.some((t) => t.function?.name === 'oc_echo') && /echo|回显/i.test(text) && !hasToolResult) {
        return {
          kind: 'stream',
          chunks: [
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [{ index: 0, id: 'call_mock_1', type: 'function', function: { name: 'oc_echo', arguments: JSON.stringify({ text }) } }],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
              usage: { prompt_tokens: 15, completion_tokens: 4 },
            },
          ],
        }
      }
      if (hasToolResult) {
        const lastTool = [...messages].reverse().find((m) => m.role === 'tool')
        const toolText = typeof lastTool?.content === 'string' ? lastTool.content : ''
        return {
          kind: 'stream',
          chunks: [
            ...splitText(`（mock）工具已执行，结果：${toolText}`),
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 8 } },
          ],
        }
      }
      return defaultScript(body)
    },
  })
  return {
    gateway: createOpencodeGateway({ server: mock.url, apiKey: 'test-key' }),
    source: `mock SSE (${mock.url})`,
  }
}

async function createShell(): Promise<ShellState> {
  const { gateway, source } = await buildGateway()

  const tools = new DefaultToolCapabilityRegistry()
  await tools.register(ocEcho)
  await tools.register(ocGetTime)

  let currentAgentId: AgentID
  const deliveries = userDeliveryQueue()
  const display = { streamedAny: false }

  const kernel = new AgentKernel({
    gateway,
    defaultModel: { provider: 'opencode', id: process.env.OPENCODE_MODEL ?? DEFAULT_MODEL },
    tools,
    onEvent: (agentId, event) => {
      if (agentId === currentAgentId && event.type === 'text-delta') {
        display.streamedAny = true
        process.stdout.write(event.text)
      }
    },
    onUserDelivery: (delivery) => deliveries.push(delivery),
  })

  // 带工具白名单的示例模板
  await kernel.templates.register({
    id: makeAgentClassID('tool-assistant'),
    name: 'ToolAssistant',
    description: '能调用工具（oc_echo / oc_get_time）的助手（示例）',
    systemPrompt: 'You are a helpful assistant with tool access. Use the available tools when appropriate.',
    tools: [{ id: 'oc_echo' }, { id: 'oc_get_time' }],
    permission: 'normal',
    memoryScope: [],
  })

  await kernel.registerUser('User')
  currentAgentId = await kernel.getOrCreateAgent(makeAgentClassID('simple-chat'), DEFAULT_PROJECT, {
    displayName: '小助手',
  })

  const state: ShellState = { kernel, currentAgentId, source, deliveries, display }
  // 消费初始 agent 的首信自动回复（自我介绍），保持第一条消息干净。
  await drainRepliesUntil(state, currentAgentId)
  return state
}

function contentText(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content)
}

/** 解析发送者戳，返回（senderId, text）。 */
function parseStamp(message: string): { sender: string; text: string } {
  const match = /^<sender id="([^"]+)">([\s\S]*?)<\/sender>$/.exec(message)
  if (match) return { sender: match[1] ?? '', text: match[2] ?? '' }
  return { sender: '', text: message }
}

/** 消费掉指定 agent 的"首信自动回复"（默认 userPrompt 触发），保持后续对话干净。 */
async function drainRepliesUntil(state: ShellState, agentId: AgentID, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const race = await Promise.race<unknown>([
      state.deliveries.next(),
      new Promise((resolve) => setTimeout(() => resolve(null), deadline - Date.now())),
    ])
    if (race === null) return
    const delivery = race as UserDelivery
    const letter = delivery.letters[0]
    const { sender } = parseStamp(contentText(letter?.content ?? ''))
    if (sender === agentId) return
  }
}

async function chat(state: ShellState, input: string): Promise<void> {
  console.log(`\n[user] ${input}`)
  process.stdout.write('[assistant] ')
  state.display.streamedAny = false
  await state.kernel.sendUserMessage(state.currentAgentId, input)
  // 等待当前 agent 的回信（跳过其他 agent 的异步回信，避免串扰）。
  for (;;) {
    const delivery = await state.deliveries.next()
    const letter = delivery.letters[0]
    const { sender, text } = parseStamp(contentText(letter?.content ?? ''))
    if (!sender || sender === state.currentAgentId) {
      process.stdout.write('\n')
      if (!state.display.streamedAny) console.log(text)
      return
    }
  }
}

async function handleCommand(state: ShellState, line: string): Promise<boolean> {
  const [cmd, ...rest] = line.split(/\s+/)
  switch (cmd) {
    case '/help':
      console.log('命令: /new <classId> [name] [userPrompt] · /use <agentId> · /agents · /templates · /tools · /source · /help · /exit')
      return false
    case '/exit':
      return true
    case '/source':
      console.log(state.source)
      return false
    case '/tools': {
      if (!state.kernel.tools) {
        console.log('未启用工具系统')
        return false
      }
      const list = await state.kernel.tools.list()
      for (const t of list) console.log(`  ${t.id}  [${t.permission}]  (${t.category ?? 'business'})  ${t.description}`)
      return false
    }
    case '/templates': {
      const list = await state.kernel.templates.list()
      for (const t of list) console.log(`  ${t.id}  ${t.name}  [${t.permission}]  ${t.description}`)
      return false
    }
    case '/agents': {
      const space = await state.kernel.spaces.getOrCreate(DEFAULT_PROJECT)
      const agents = await state.kernel.instances.listBySpace(space.id)
      for (const a of agents) {
        const marker = a.id === state.currentAgentId ? '*' : ' '
        console.log(` ${marker} ${a.id}  ${a.displayName}  <${a.classRef}>  ${a.status}  turns=${a.turnCount}  creator=${a.creatorId}`)
      }
      return false
    }
    case '/new': {
      const classId = rest[0] as string | undefined
      if (!classId) {
        console.log('用法: /new <classId> [name] [userPrompt]')
        return false
      }
      const name = rest[1]
      const userPrompt = rest[2] ?? DEFAULT_USER_PROMPT
      const agentId = await state.kernel.instantiateAgent(
        { classId: makeAgentClassID(classId), creatorId: USER_ID, userPrompt, displayName: name },
        DEFAULT_PROJECT,
      )
      state.currentAgentId = agentId
      console.log(`已创建并切换到: ${agentId} (${name ?? classId})`)
      // 消费首信自动回复，保持后续对话干净。
      await drainRepliesUntil(state, agentId)
      return false
    }
    case '/use': {
      const agentId = rest[0] as string | undefined
      if (!agentId) {
        console.log('用法: /use <agentId>')
        return false
      }
      await state.kernel.instances.get(makeAgentID(agentId))
      state.currentAgentId = makeAgentID(agentId)
      console.log(`已切换到: ${agentId}`)
      return false
    }
    default:
      console.log(`未知命令: ${cmd}（输入 /help 查看）`)
      return false
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function splitText(text: string): Array<Record<string, unknown>> {
  return text.split(/(?<=。) |(?<=。)/).map((piece, i) => ({
    id: `chatcmpl-mock-${i}`,
    choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
  }))
}

async function main(): Promise<number> {
  const state = await createShell()
  console.log('====================================================')
  console.log(' stem core 调试 shell（临时面板 user0）')
  console.log(` gateway: ${state.source}`)
  console.log(` 模板: ${BUILTIN_TEMPLATES.map((t) => t.id).join(', ')}, tool-assistant`)
  console.log(` 当前实例: ${state.currentAgentId} (小助手)`)
  console.log(' 工具演示: /new tool-assistant 再问 "echo hello"')
  console.log(' 直接输入对话；/help 查看命令；/exit 退出')
  console.log('====================================================')

  const rl = createInterface({ input, output, terminal: false })

  for await (const rawLine of rl) {
    const line = rawLine.trim()
    if (line === '') continue
    try {
      if (line.startsWith('/')) {
        const shouldExit = await handleCommand(state, line)
        if (shouldExit) break
      } else {
        await chat(state, line)
      }
    } catch (error) {
      if (isGatewayError(error)) {
        const e = error as GatewayError
        console.error(`\n[error] GatewayError(kind=${e.kind}${e.statusCode !== undefined ? `, http=${e.statusCode}` : ''}) ${e.message}`)
      } else if (typeof error === 'object' && error !== null && 'kind' in error) {
        const e = error as { kind: string }
        console.error(`\n[error] KernelError(kind=${e.kind}) ${JSON.stringify(error)}`)
      } else {
        console.error('\n[error]', error)
      }
    }
  }

  rl.close()
  console.log('\nbye')
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('[fatal]', error)
    process.exit(1)
  })
