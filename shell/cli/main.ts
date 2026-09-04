// ============================================================
// shell/cli/main.ts —— 参考 CLI shell（bootStem 装配，终端扮演 user0）
//
// 交互模型：user0 是面板（根接线 assemble:false，自身不跑 LLM 轮）——
// 用户输入 = 以 user0 身份向当前实例投递信件；实例回信到达 user0 信箱，
// 经事件流汇总展示。ask 审批同样走信件（access_request → 确认 → access_reply）。
//
// 运行（S6/R11 opencode-style：`stem [path]`——在项目里直接启动，项目目录即空间）：
//   npm run shell                    # cwd 即空间
//   npm run shell -- test/space-demo   # 指定目录（仓库演示空间）
//   ALIBABA_API_KEY=<key> npm run shell   # 真实网关（config providers 声明的 key_env）
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
import { isAbsolute, resolve } from 'node:path'
import {
  Kernel,
  makeAgentClassID,
  makeAgentID,
  makeAgentSpaceID,
  BUILTIN_TEMPLATES,
  USER_ID,
  type AgentID,
  type AgentClassID,
} from '../../src/core/kernel'
import { GatewayError, isGatewayError } from '../../src/core/gateway'
import { DefaultToolCapabilityRegistry, type ToolCapability } from '../../src/core/tools'
import type { AccessReply } from '../../src/core/tools'
import type { PilotEvent } from '../../src/core/events'
import { QueueDialog, formatDialog, parseSelection, type DialogRequest } from './ui/dialog'
import { bootStem } from './platform'
import type { InitReport, StemSystem } from '../../src/core/init'
import type { StemConfig } from '../../src/core/config'

/** S6/R11 空间定位：位置参数 > STEM_PROJECT_ROOT > cwd（一进程 = 一空间 = 一 .stem）。
 *  取首个非 flag 参数——npm 吞透传 `--` 与否（npm run vs npx）以及后续扩展的
 *  --flags 都不许误入空间位（旧实现把 '--' 当路径在 cwd 长出 './--/' 鬼空间）。 */
const DEFAULT_PROJECT = resolve(process.argv.slice(2).find((a) => !a.startsWith('-')) ?? process.env.STEM_PROJECT_ROOT ?? process.cwd())
const DEFAULT_USER_PROMPT = '你好，请做一个简短的自我介绍。'

interface ShellState {
  kernel: Kernel
  /** 装配后的系统句柄（优雅收尾用 dispose——异步闭合进行轮并落行）。 */
  system: StemSystem
  currentAgentId: AgentID
  source: string
  /** 弹窗模块（权限确认等队列弹窗）。 */
  dialogs: QueueDialog
  /** 流式输出状态（避免收信重复打印）。 */
  display: { streamedAny: boolean }
  /** 初始化报告（目录扫描结果，供 /config 展示）。 */
  init: InitReport
  /** 生效配置（唯一配置文件读取结果）。 */
  config: StemConfig
}

/** 演示业务工具已随 S7 清理（oc_* 三件套唯一消费者 tool-assistant 类为死配置）。 */

/** 节点 shell 主装配。 */
async function createShell(): Promise<ShellState> {
  const dialogs = new QueueDialog()
  const display = { streamedAny: false }
  // 先建 state 骨架，回调引用 state.currentAgentId（动态，避免旧值闭包）。
  const state: ShellState = {
    kernel: undefined as never,
    system: undefined as never,
    currentAgentId: '' as never,
    source: '',
    dialogs,
    display,
    init: undefined as never,
    config: undefined as never,
  }

  // 自治系统装配（platform.bootStem：config + 网关 + createStemSystem + user0 实例化；
  // extension 工具由 init 管线按 config.extensions 点名装载，custom 走 .stem/ 扫描）。
  const { system, source } = await bootStem({
    projectRoot: DEFAULT_PROJECT,
    // 统一事件流（PilotEvent）：流式 / 回信 / 访问申请（消息化）。
    onEvent: (event) => handlePilotEvent(state, event),
  })
  state.source = source
  state.kernel = system.kernel
  state.system = system
  state.init = system.init
  state.config = system.config
  for (const issue of system.init.issues) console.log(`  [init] ${formatInitIssue(issue)}`)

  state.currentAgentId = await system.kernel.getOrCreateAgent(makeAgentClassID('assistant'), DEFAULT_PROJECT, {
    userPrompt: '你好，请做一个简短的自我介绍。',
  })

  return state
}

function contentText(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content)
}

/** 格式化初始化问题（不同 issue 形状不同）。 */
function formatInitIssue(issue: InitReport['issues'][number]): string {
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
      console.log('命令: /new <classId> [name] [userPrompt] · /use <agentId> · /agents · /templates · /tools · /config · /source · /compact [agentId] · /dream [agentId] · /stop · /help · /exit')
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
      const cfg = state.config
      const init = state.init
      console.log(`  config: ${DEFAULT_PROJECT}/.stem/stem.jsonc`)
      console.log(
        `  providers: ${
          cfg.providers !== undefined && Object.keys(cfg.providers).length > 0
            ? Object.entries(cfg.providers)
                .map(([k, v]) => `${k}(${v.key_env !== undefined ? `$${v.key_env}` : '匿名'}${v.models !== undefined && v.models.length > 0 ? `·${String(v.models.length)}模型` : ''})`)
                .join(', ')
            : '(未注册——一切 LLM 调用硬错)'
        }`,
      )
      console.log(`  家学 user.model: ${cfg.user?.model !== undefined ? `${cfg.user.model.provider}/${cfg.user.model.id}` : '(缺失——boot 应已报错)'}`)
      console.log(`  autoApprove: ${cfg.autoApprove ?? false}`)
      console.log(`  sendCountdown: ${cfg.sendCountdown ?? '(未配置)'}`)
      console.log(`  user 类: ${cfg.user?.tools !== undefined ? `tools=${JSON.stringify(cfg.user.tools)}` : '(内置默认表)'}`)
      console.log(`  context: ${cfg.context !== undefined ? JSON.stringify(cfg.context) : '(默认 window/compact)'}`)
      console.log(`  bash: ${cfg.bash !== undefined ? JSON.stringify(cfg.bash) : '(默认 120s/50k)'}`)
      console.log(`  extensions: ${JSON.stringify(cfg.extensions ?? { tools: '<default fs five-set>', agent: '[]', context: '[]' })}`)
      console.log(`  注册工具: ${init.tools.length > 0 ? init.tools.map((t) => `${t.id}(${t.file})`).join(', ') : '-'}`)
      console.log(`  注册 agent: ${init.agents.length > 0 ? init.agents.map((a) => `${a.id}(${a.file})`).join(', ') : '-'}`)
      console.log(`  注册策略: ${init.strategies.length > 0 ? init.strategies.map((s) => `${s.id}(${s.file})`).join(', ') : '-'}`)
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
        console.log(`  ${t.name}  tools=${t.tools === undefined ? 'inherit' : Object.keys(t.tools).length > 0 ? Object.entries(t.tools).map(([k, v]) => `${k}:${v}`).join(',') : '-'}${t.contextStrategy ? `  strategy=${t.contextStrategy}` : ''}  ${t.description}`)
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
    case '/compact':
    case '/dream': {
      // 策略手动动作（compact = classic 压缩；dream = cortex 提前做梦）。
      const action = cmd === '/compact' ? 'compact' : 'dream'
      const target = (rest[0] as string | undefined) ?? (state.currentAgentId as string | undefined)
      if (!target) {
        console.log(`用法: ${cmd} [agentId]`)
        return false
      }
      console.log(`${action}: ${await state.kernel.contextManager.runStrategyAction(target, action)}`)
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

async function main(): Promise<number> {
  const state = await createShell()
  console.log('====================================================')
  console.log(' stem CLI shell（扮演 user0 根面板）')
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
      // halt 收尾是异步（消息闭合 + 状态快照落行）：等 boot.system.dispose
      // 完成再退，超时 5s 兜底强退。
      const closing = state.system.dispose().catch((e: unknown) => console.error('[shutdown]', e))
      void Promise.race([closing, new Promise((r) => setTimeout(r, 5000))]).then(() => {
        rl.close()
        console.log('\nbye')
        process.exit(0)
      })
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
