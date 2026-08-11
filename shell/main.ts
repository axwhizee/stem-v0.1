// ============================================================
// shell/main.ts —— 临时 shell 层（core 调试/检验用）
//
// 目的：在接入 VSCode 之前，用 CLI 检验 core 层（Kernel）可用性。
// 链路：shell → AgentKernel(getOrCreateAgent + run) → AgentTemplateRegistry
//        → AgentRuntime → ModelGateway（真实 go/zen 或 mock SSE 兜底）
//
// 运行：
//   npm run shell
//   OPENCODE_API_KEY=<key> npm run shell     # 走真实 go/zen
//
// 命令：
//   直接输入 → 与当前 agent 对话（流式输出）
//   /new <classId> [name]  新建实例
//   /use <agentId>         切换当前实例
//   /agents                列出实例
//   /templates             列出模板
//   /source                显示 gateway 来源
//   /help | /exit
// ============================================================

import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import {
  AgentKernel,
  makeAgentClassID,
  makeAgentID,
  BUILTIN_TEMPLATES,
  type AgentID,
  type AgentClassID,
} from '../src/core/kernel'
import { createOpencodeGateway, GatewayError, isGatewayError, type ModelGateway } from '../src/core/gateway'
import { startMockSse } from '../test-support/mockSse'

const DEFAULT_MODEL = 'deepseek-v4-flash'
const DEFAULT_PROJECT = '/workspace/stem-demo'

interface ShellState {
  kernel: AgentKernel
  currentAgentId: AgentID
  source: string
}

async function buildGateway(): Promise<{ gateway: ModelGateway; source: string }> {
  const apiKey = process.env.OPENCODE_API_KEY
  if (apiKey) {
    return { gateway: createOpencodeGateway({ apiKey }), source: `real go/zen (model=${process.env.OPENCODE_MODEL ?? DEFAULT_MODEL})` }
  }
  const mock = await startMockSse({ requiredApiKey: 'test-key', delayMs: 6 })
  return {
    gateway: createOpencodeGateway({ server: mock.url, apiKey: 'test-key' }),
    source: `mock SSE (${mock.url})`,
  }
}

async function createShell(): Promise<ShellState> {
  const { gateway, source } = await buildGateway()
  const kernel = new AgentKernel({
    gateway,
    defaultModel: { provider: 'opencode', id: process.env.OPENCODE_MODEL ?? DEFAULT_MODEL },
  })
  const agentId = await kernel.getOrCreateAgent(makeAgentClassID('simple-chat'), DEFAULT_PROJECT, {
    displayName: '小助手',
  })
  return { kernel, currentAgentId: agentId, source }
}

async function chat(state: ShellState, input: string): Promise<void> {
  console.log(`\n[user] ${input}`)
  process.stdout.write('[assistant] ')
  const result = await state.kernel.run(state.currentAgentId, input, {
    onEvent: (event) => {
      if (event.type === 'text-delta') process.stdout.write(event.text)
    },
  })
  process.stdout.write('\n')
  if (result.reasoning) console.log(`[reasoning] ${truncate(result.reasoning, 160)}`)
  console.log(`[finish] ${result.finishReason} · turns=${result.turnCount} · usage=${result.usage ? `${result.usage.inputTokens}+${result.usage.outputTokens} tok` : 'n/a'}`)
}

async function handleCommand(state: ShellState, line: string): Promise<boolean> {
  const [cmd, ...rest] = line.split(/\s+/)
  switch (cmd) {
    case '/help':
      console.log('命令: /new <classId> [name] · /use <agentId> · /agents · /templates · /source · /help · /exit')
      return false
    case '/exit':
      return true
    case '/source':
      console.log(state.source)
      return false
    case '/templates': {
      const list = await state.kernel.templates.list()
      for (const t of list) console.log(`  ${t.id}  ${t.name}  [${t.permission}]  ${t.description}`)
      return false
    }
    case '/agents': {
      const agents = await state.kernel.instances.listBySpace(await getDefaultSpace(state))
      for (const a of agents) {
        const marker = a.id === state.currentAgentId ? '*' : ' '
        console.log(` ${marker} ${a.id}  ${a.displayName}  <${a.classRef}>  ${a.status}  turns=${a.turnCount}`)
      }
      return false
    }
    case '/new': {
      const classId = rest[0] as string | undefined
      if (!classId) {
        console.log('用法: /new <classId> [name]')
        return false
      }
      const name = rest[1]
      const instance = await state.kernel.instances.instantiate(makeAgentClassID(classId), {
        spaceId: await getDefaultSpace(state),
        displayName: name,
      })
      state.currentAgentId = instance.id
      console.log(`已创建并切换到: ${instance.id} (${instance.displayName})`)
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

async function getDefaultSpace(state: ShellState) {
  const space = await state.kernel.spaces.getOrCreate(DEFAULT_PROJECT)
  return space.id
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

async function main(): Promise<number> {
  const state = await createShell()
  console.log('====================================================')
  console.log(' stem core 调试 shell（临时）')
  console.log(` gateway: ${state.source}`)
  console.log(` 模板: ${BUILTIN_TEMPLATES.map((t) => t.id).join(', ')}`)
  console.log(` 当前实例: ${state.currentAgentId} (小助手)`)
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
