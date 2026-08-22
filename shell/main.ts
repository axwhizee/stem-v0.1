// ============================================================
// shell/main.ts —— 临时 shell 层（core 调试/检验用）
//
// 面板角色：注册为 user0（接入总线 + 邮局，与 agent 一视同仁）。
// 用户输入 → bus.send → 邮局 → 送信 → Runtime 处理 → 自动寄信
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
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import {
  Kernel,
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
import type { AccessReply } from '../src/core/tools'
import type { PilotEvent } from '../src/core/events'
import { startMockSse, defaultScript, type MockResponse } from '../test-support/mockSse'
import { QueueDialog, formatDialog, parseSelection, type DialogRequest } from './ui/dialog'
import { createHostTools } from './tools'
import { createNodeConfigBundle, FALLBACK_MODEL } from './config'
import { runInit, type InitReport } from '../src/core/init'
import { parseModelRef } from '../src/core/config'

const DEFAULT_MODEL = 'deepseek-v4-flash'
const DEFAULT_PROJECT = process.env.STEM_PROJECT_ROOT ?? join(process.cwd(), 'tmp')
const DEFAULT_USER_PROMPT = '你好，请做一个简短的自我介绍。'

interface ShellState {
  kernel: Kernel
  currentAgentId: AgentID
  source: string
  /** 弹窗模块（权限确认等队列弹窗）。 */
  dialogs: QueueDialog
  /** 流式输出状态（避免收信重复打印）。 */
  display: { streamedAny: boolean }
  /** 初始化报告（config + 注册表，供 /config 展示）。 */
  init: InitReport
}

/** 演示业务工具：回显文本。 */
const ocEcho: ToolCapability = {
  id: 'oc_echo',
  description: '回显一段文本（原样返回）。',
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
  category: 'business',
  parameters: { type: 'object', properties: {} },
  execute: () => ({ text: `当前 UTC 时间: ${new Date().toISOString()}` }),
}

/** 测试用读取工具：读取指定文件内容（相对路径基于工作区）。 */
const ocReadFile: ToolCapability = {
  id: 'oc_read_file',
  description: '读取指定文件的内容并返回。',
  category: 'business',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: '文件路径（绝对路径）' } },
    required: ['path'],
  },
  execute: async (input) => {
    const filePath = (input as { path: string }).path
    if (!isAbsolute(filePath)) {
      return { text: `错误：需要绝对路径，收到 ${filePath}` }
    }
    try {
      const content = await readFile(filePath, 'utf8')
      const summary = content.length > 2000 ? `${content.slice(0, 2000)}\n…（截断）` : content
      return { text: `文件内容（${filePath}）:\n${summary}` }
    } catch (error) {
      return { text: `读取失败: ${error instanceof Error ? error.message : String(error)}` }
    }
  },
}

async function buildGateway(modelId?: string): Promise<{ gateway: ModelGateway; source: string }> {
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

async function createShell(): Promise<ShellState> {
  // 1. 读取唯一配置（`<projectRoot>/.stem/stem.jsonc`）。
  const bundle = createNodeConfigBundle(DEFAULT_PROJECT)
  const loaded = await bundle.store.load()
  const config = loaded.config
  const model = parseModelRef(config.model, FALLBACK_MODEL)

  const { gateway, source } = await buildGateway(model.id)

  const tools = new DefaultToolCapabilityRegistry()
  await tools.register(ocEcho)
  await tools.register(ocGetTime)
  await tools.register(ocReadFile)
  // host 内置工具（kind=shell）：read/write/edit/grep/glob，操作真实文件系统。
  for (const tool of createHostTools(DEFAULT_PROJECT)) {
    await tools.register(tool)
  }

  const dialogs = new QueueDialog()
  const display = { streamedAny: false }
  // 先建 state 骨架，回调引用 state.currentAgentId（动态，避免旧值闭包）。
  const state: ShellState = {
    kernel: undefined as never,
    currentAgentId: '' as never,
    source,
    dialogs,
    display,
    init: undefined as never,
  }

  const kernel = new Kernel({
    gateway,
    defaultModel: model,
    defaultCountdownMs: config.sendCountdown,
    // 配置注入：全局默认工具访问（最弱）+ autoApprove（ask 直接放行）。
    globalToolAccessDefaults: config.permission,
    autoApprove: config.autoApprove,
    tools,
    // 统一事件流（PilotEvent）：流式 / 回信 / 访问申请（消息化）。
    onEvent: (event) => handlePilotEvent(state, event),
  })
  state.kernel = kernel

  // 2. 初始化管线：扫描 .stem/tool + .stem/agent → 同步注册表 → 注册进 core。
  const init = await runInit({
    config: { store: bundle.store, paths: bundle.paths },
    fs: bundle.fs,
    tools: { loadTool: bundle.loadTool },
    toolRegistry: tools,
    templateRegistry: kernel.templates,
  })
  state.init = init
  for (const issue of init.issues) console.log(`  [init] ${formatInitIssue(issue)}`)

  // 带工具白名单的示例模板
  await kernel.templates.register({
    name: makeAgentClassID('tool-assistant'),
    description: '能调用工具（oc_echo / oc_get_time / oc_read_file）的助手（示例）',
    systemPrompt:
      'You are a helpful assistant with tool access. Use the available tools when appropriate. If you need a result from another agent, call agent_instantiate to create it (returns its id), then context_wait(id) to await its reply.',
    tools: {
      oc_echo: 'allow',
      oc_get_time: 'allow',
      oc_read_file: 'allow',
      context_wait: 'allow',
      bus_send: 'allow',
      bus_participants: 'allow',
    },
  })

  // 创造者模板（可创建子 agent；无时间权限）
  await kernel.templates.register({
    name: makeAgentClassID('creator'),
    description: '调度者：可创建子 agent 获取信息（示例）',
    systemPrompt:
      "creator-sys: 你是调度者，负责创建子 agent 获取信息并汇总给用户。\n可用模板 id：'tool-agent'（带 oc_get_time 时间工具）、'simple-chat'（纯对话）、'coder'。\n流程：① 用 agent_instantiate 创建子 agent，参数 className 填 'tool-agent'，必填 userPrompt 说明要它做什么；它返回新建 agent 的 id。② 随后调用 context_wait(agentId)（agentId 填①返回的 id）等待子 agent 的回复——其 assistant_message 会作为 context_wait 的 tool 结果进入你的上下文。③ 拿到结果后向用户汇报。",
    tools: {
      agent_instantiate: 'allow',
      agent_list: 'allow',
      agent_terminate: 'allow',
      context_wait: 'allow',
      bus_send: 'allow',
      bus_participants: 'allow',
    },
  })

  // 系统管理工具（agent_* / bus_*）
  await kernel.registerSystemTools(tools)

  await kernel.registerUser('User')
  state.currentAgentId = await kernel.getOrCreateAgent(makeAgentClassID('simple-chat'), DEFAULT_PROJECT, {
    userPrompt: '你好，请做一个简短的自我介绍。',
  })

  return state
}

function contentText(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content)
}

/** 格式化初始化问题（不同 issue 形状不同）。 */
function formatInitIssue(issue: InitReport['issues'][number]): string {
  if (issue.kind === 'orphan_registration') {
    return `已注册但无实现文件：${issue.type} ${issue.id}（${issue.file}）`
  }
  return `${issue.kind}: ${issue.message}（${issue.file}）`
}

/** 解析发送者戳，返回（senderId, text）。 */
function parseStamp(message: string): { sender: string; text: string } {
  const match = /^<sender id="([^"]+)">([\s\S]*?)<\/sender>$/.exec(message)
  if (match) return { sender: match[1] ?? '', text: match[2] ?? '' }
  return { sender: '', text: message }
}

/** 统一事件流处理：流式输出 / 回信展示 / access_request 弹窗（消息化）。 */
function handlePilotEvent(state: ShellState, event: PilotEvent): void {
  if (event.type === 'stream') {
    // 流式正文（仅当前 agent 展示；reasoning 不打印）。
    if (event.agentId === state.currentAgentId && event.event.type === 'text-delta') {
      state.display.streamedAny = true
      process.stdout.write(event.event.text)
    }
    return
  }
  if (event.type !== 'letter') return // status/notice：日志已记录，暂不展示。
  const letter = event.letters[0]
  const { sender, text } = parseStamp(contentText(letter?.content ?? ''))
  // 访问申请（消息化，内容带 <access_request> 标记）→ 确认弹窗。
  const accessMatch = /^<access_request id="([^"]+)" accessKey="([^"]+)" agentId="([^"]+)">/.exec(text)
  if (accessMatch) {
    const requestId = accessMatch[1] ?? ''
    const accessKey = accessMatch[2] ?? ''
    const agentId = accessMatch[3] ?? ''
    const request: DialogRequest = {
      title: '工具访问确认',
      body: `agent ${agentId} 正在申请「${accessKey}」工具访问`,
      options: [
        { id: 'once', label: '单次批准' },
        { id: 'always', label: '始终批准' },
        { id: 'reject', label: '拒绝' },
      ],
    }
    void state.dialogs.push(request).then((selected) => {
      const reply = selected[0] as AccessReply | undefined
      if (!reply) return
      void state.kernel.access.reply({ requestId, reply }, USER_ID)
    })
    // 若该弹窗立即激活（队列空闲），打印弹窗；否则已由队列中的激活弹窗占据。
    if (state.dialogs.active) console.log('\n' + formatDialog(state.dialogs.activeRequest!))
    return
  }
  // 普通回信。
  const label = sender && sender !== state.currentAgentId ? `\n[来自 ${sender}]` : '\n[assistant]'
  console.log(label)
  // 若该回复未经流式显示（无文本流），直接打印文本。
  if (!state.display.streamedAny) console.log(text)
  state.display.streamedAny = false
}

/** 发送一条用户消息（回信经 PanelBus 异步展示，不阻塞主循环）。 */
async function chat(state: ShellState, input: string): Promise<void> {
  state.display.streamedAny = false
  console.log(`\n[user] ${input}`)
  await state.kernel.sendUserMessage(state.currentAgentId, input)
}

async function handleCommand(state: ShellState, line: string): Promise<boolean> {
  const [cmd, ...rest] = line.split(/\s+/)
  switch (cmd) {
    case '/help':
      console.log('命令: /new <classId> [name] [userPrompt] · /use <agentId> · /agents · /templates · /tools · /config · /source · /stop · /help · /exit')
      return false
    case '/exit':
      return true
    case '/stop': {
      // 用户主动中断当前 agent（仅暂停，消息闭合，可恢复）。
      const active = state.kernel.activeAgents()
      if (active.length === 0) {
        console.log('（当前无活跃 agent 可中断）')
        return false
      }
      for (const id of active) await state.kernel.interruptAgent(id as string)
      console.log(`已中断 ${active.length} 个活跃 agent（消息已闭合，可继续对话恢复）`)
      return false
    }
    case '/config': {
      const init = state.init
      console.log(`  config: ${DEFAULT_PROJECT}/.stem/stem.jsonc`)
      console.log(`  model: ${init.config.model ?? '(未配置)'}`)
      console.log(`  autoApprove: ${init.config.autoApprove ?? false}`)
      console.log(`  sendCountdown: ${init.config.sendCountdown ?? '(未配置)'}`)
      console.log(`  全局权限: ${Object.keys(init.config.permission ?? {}).length > 0 ? JSON.stringify(init.config.permission) : '(空，默认 ask)'}`)
      console.log(`  注册工具: ${init.tools.length > 0 ? init.tools.map((t) => `${t.id}(${t.file})`).join(', ') : '-'}`)
      console.log(`  注册 agent: ${init.agents.length > 0 ? init.agents.map((a) => `${a.id}(${a.file})`).join(', ') : '-'}`)
      return false
    }
    case '/source':
      console.log(state.source)
      return false
    case '/tools': {
      if (!state.kernel.tools) {
        console.log('未启用工具系统')
        return false
      }
      const list = await state.kernel.tools.list()
      for (const t of list) console.log(`  ${t.id}  [${t.accessKey ?? t.id}]  (${t.category ?? 'business'})  ${t.description}`)
      return false
    }
    case '/templates': {
      const list = await state.kernel.templates.list()
      for (const t of list)
        console.log(`  ${t.name}  tools=${Object.keys(t.tools).length > 0 ? Object.entries(t.tools).map(([k, v]) => `${k}:${v}`).join(',') : '-'}${t.contextStrategy ? `  strategy=${t.contextStrategy}` : ''}  ${t.description}`)
      return false
    }
    case '/agents': {
      const space = await state.kernel.spaces.getOrCreate(DEFAULT_PROJECT)
      const agents = await state.kernel.instances.listBySpace(space.id)
      for (const a of agents) {
        const marker = a.id === state.currentAgentId ? '*' : ' '
        console.log(` ${marker} ${a.id}  ${a.displayName}  <${a.classRef}>  parent=${a.parentId ?? '-'}  ${a.status}  turns=${a.turnCount}`)
      }
      return false
    }
    case '/new': {
      const className = rest[0] as string | undefined
      if (!className) {
        console.log('用法: /new <className> [userPrompt]')
        return false
      }
      const userPrompt = rest[1] ?? DEFAULT_USER_PROMPT
      const agentId = await state.kernel.instantiateAgent(
        { className: makeAgentClassID(className), parentId: makeAgentID(USER_ID), userPrompt },
        DEFAULT_PROJECT,
      )
      state.currentAgentId = agentId
      console.log(`已创建并切换到: ${agentId} (${className})`)
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

async function main(): Promise<number> {
  const state = await createShell()
  console.log('====================================================')
  console.log(' stem core 调试 shell（临时面板 user0）')
  console.log(` gateway: ${state.source}`)
  console.log(` 配置: ${DEFAULT_PROJECT}/.stem/stem.jsonc（唯一配置文件）`)
  console.log(` 注册用户工具: ${state.init.tools.length > 0 ? state.init.tools.map((t) => t.id).join(', ') : '-'}`)
  console.log(` 注册用户 agent: ${state.init.agents.length > 0 ? state.init.agents.map((a) => a.id).join(', ') : '-'}`)
  console.log(` 模板: ${BUILTIN_TEMPLATES.map((t) => t.name).join(', ')}, tool-assistant, creator${state.init.agents.length > 0 ? ', ' + state.init.agents.map((a) => a.id).join(', ') : ''}`)
  console.log(` 当前实例: ${state.currentAgentId} (小助手)`)
  console.log(' 工具演示: /new tool-assistant 再问 "echo hello"；/new creator 再问 "创建一个助手读取时间"')
  console.log(' 直接输入对话；/help 查看命令；/exit 退出')
  console.log('====================================================')

  const rl = createInterface({ input, output, terminal: false })

  // 进程中断优雅收尾：中断所有活跃 agent（消息闭合入库）后再退出。
  let exiting = false
  const gracefulExit = (signal: string) => {
    if (exiting) process.exit(130)
    exiting = true
    const active = state.kernel.activeAgents()
    if (active.length > 0) {
      state.kernel.abortAllAgents()
      console.log(`\n[${signal}] 已请求中断 ${active.length} 个活跃 agent（消息闭合中）…`)
      // 给 processDelivery 的 halt 收尾一点时间（消息入库）。
      setTimeout(() => {
        rl.close()
        console.log('\nbye')
        process.exit(0)
      }, 300)
    } else {
      rl.close()
      console.log('\nbye')
      process.exit(0)
    }
  }
  process.on('SIGINT', () => gracefulExit('SIGINT'))
  process.on('SIGTERM', () => gracefulExit('SIGTERM'))

  for await (const rawLine of rl) {
    const line = rawLine.trim()
    if (line === '') continue
    try {
      // 弹窗优先：有激活弹窗 → 该行作为选项选择。
      if (state.dialogs.active) {
        const request = state.dialogs.activeRequest
        if (!request) continue
        const ids = parseSelection(line, request)
        if (ids === null) {
          console.log('无效输入，请重新选择:\n' + formatDialog(request))
          continue
        }
        state.dialogs.submit(ids)
        // 队列中还有弹窗 → 激活并打印下一个。
        if (state.dialogs.active) console.log(formatDialog(state.dialogs.activeRequest!))
        continue
      }
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
