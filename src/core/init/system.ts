// ============================================================
// core/init/system.ts —— createStemSystem（系统初始化与装配主入口）
//
// 自治系统组合根：任何 shell（cli/webui）注入平台能力即可装配出
// 完整可运行的最小系统，避免各 shell 各自装配导致发散。
// 装配顺序（固定）：
//   1. 读取唯一配置（.stem/stem.jsonc）；
//   2. 工具注册表 + Kernel（user 类 = config.user 对象，tools 给出整表替换）；
//   3. 系统工具（agent_*/bus_*/context_* + access_reply）+ 宿主工具；
//   4. skill 生态（注册表 + skill 工具，发现走工具 init 生命周期）；
//   5. init 管线（扫描 .stem/tools + .stem/agent + .stem/context → 注册；目录即真相）；
//   6. Pilot 初始化（内部实例化根 agent user0，user 类）；
//   7. 工具 initAll（skill 发现等）；
//   8. 用户注入钩子（init 末尾，深度扩展自定义）。
// ============================================================

import type { ConfigError, ConfigPaths, ConfigStore, StemConfig } from '../config'
import { defaultStemConfig } from '../config'
import type { ModelGateway, UsageEvent } from '../gateway'
import type { Logger } from '../logging'
import type { MessageStore, TimerFactory } from '../context'
import { DEFAULT_CONTEXT_SETTINGS } from '../context'
import type { InstanceStore } from '../kernel'
import type { ClassStore } from '../kernel'
import type { ToolCapability, ToolCapabilityRegistry } from '../tools'
import { createBashTool, DefaultSkillRegistry, DefaultToolCapabilityRegistry, createSkillTool } from '../tools'
import type { ShellRunner } from '../tools'
import { Kernel } from '../kernel'
import type { Pilot } from '../pilot'
import { createPilot } from '../pilot'
import type { PilotEvent } from '../events'
import { runInit } from './init'
import type { InitDeps, InitReport, ClassFs } from './types'
import { agentFileOf, serializeAgentClass } from './agentSerialize'

/** 系统上下文（用户注入钩子入参）。 */
export interface StemSystem {
  readonly kernel: Kernel
  /** user0 扮演接口（外部交互核心）。 */
  readonly pilot: Pilot
  readonly tools: ToolCapabilityRegistry
  /** 生效配置（唯一配置文件读取结果；目录即真相，无镜像回写）。 */
  readonly config: StemConfig
  readonly init: InitReport
    /** 优雅收尾（中断所有活跃 agent；注入 stateStore 时释放存储句柄）。 */
    readonly dispose: () => Promise<void>
}

/** 用户注入钩子（init 末尾调用，深度扩展自定义）。 */
export type UserInitHook = (ctx: StemSystem) => Promise<void> | void

export interface StemSystemDeps {
  readonly config: { readonly store: ConfigStore; readonly paths: ConfigPaths }
  readonly fs: InitDeps['fs']
  readonly tools: InitDeps['tools']
  readonly gateway: ModelGateway
  readonly logger?: Logger
  readonly timer?: TimerFactory
  readonly maxSteps?: number
  readonly estimateCost?: (usage: UsageEvent | undefined) => number
  /** 宿主工具（kind=shell，如 read/write/edit/grep/glob）。 */
  readonly hostTools?: readonly ToolCapability[]
  /**
   * shell 执行端口（宿主注入，典型 = node child_process 实现）。
   * 提供后装配 bash 工具（internal · 最小系统对外操作面，config.bash 供参数）。
   */
  readonly shellRunner?: ShellRunner
  /**
   * 类回写文件端口（S5.2 进化书写面，宿主注入 node fs 实现）。
   * 提供后 agent_class_create/update 序列化落盘 `.stem/agent/<name>.md`
   * （目录即真相：重启由 runInit 扫描装载，进化跨重启生效）；缺省 = 仅内存。
   */
  readonly classFs?: ClassFs
  /** 用户注入钩子（init 末尾调用）。 */
  readonly userHooks?: readonly UserInitHook[]
  /** 事件流回调（PilotEvent；pilot 创建后订阅）。 */
  readonly onEvent?: (event: PilotEvent) => void
  /**
   * 持久化端口（宿主注入，典型：shell 的 SQLite 实现）。注入后个体层
   *（消息/实例）write-through 落库并在启动期恢复；缺省纯内存。
   * 类层持久仍走文件（.stem/agent/*.md 镜像注册表），不进 DB。
   */
  readonly stateStore?: { readonly messages: MessageStore; readonly instances: InstanceStore }
}

export async function createStemSystem(deps: StemSystemDeps): Promise<StemSystem> {
  const loaded = await deps.config.store.load()
  // S6/R12：首启零兜底链路的正面表达——config 文件不存在时，等效内存配置 =
  // 首启模板的解析产物（runInit 随后把同一文本落盘；顶层 model 链已拆除，
  // 家学锚点由模板的 user.model 承载，杜绝"无配置装配出无锚系统"）。
  const config = loaded.exists ? loaded.config : defaultStemConfig()

  // 家学硬校验（boot fail-fast）：config.user.model = 全体 agent 模型解析链
  // （显式 > 类基因 > 父继承 > 家学）的链尾锚点，缺失即全系统无缺省模型。
  if (config.user?.model === undefined) {
    throw {
      kind: 'invalid_config',
      message:
        'user.model 必填（家学锚点 = 全体模型的链尾缺省；模板默认 "opencode-go/deepseek-v4-flash"，请在 .stem/stem.jsonc 的 user.model 补全）',
    } as ConfigError
  }

  // 工具注册表 + skill 生态 + Kernel（user 类 = config.user 全对象；根策略收敛起点）。
  const tools = new DefaultToolCapabilityRegistry()
  const skills = new DefaultSkillRegistry()
  const settings = settingsOf(config)
  // 类回写端口装配（S5.2）：注入 classFs 才建 store；序列化在 core、文件 IO 在宿主。
  const classStore: ClassStore | undefined =
    deps.classFs === undefined
      ? undefined
      : {
          save: async (cls) => {
            const file = agentFileOf(deps.config.paths.agentDir, cls.name as string)
            await deps.classFs!.ensureDir(deps.config.paths.agentDir)
            await deps.classFs!.writeText(file, serializeAgentClass(cls))
          },
        }
  const kernel = new Kernel({
    gateway: deps.gateway,
    userClass: config.user,
    // S6/R11：项目根 = 空间身份（根挂真实空间；.stem 目录即世界）。
    project: deps.config.paths.projectRoot,
    skills,
    tools,
    defaultCountdownMs: config.sendCountdown,
    autoApprove: config.autoApprove,
    timer: deps.timer,
    maxSteps: deps.maxSteps ?? config.maxSteps,
    estimateCost: deps.estimateCost,
    logger: deps.logger,
    ...(settings !== undefined ? { contextSettings: settings } : {}),
    ...(deps.stateStore !== undefined ? { stateStore: deps.stateStore } : {}),
    ...(classStore !== undefined ? { classStore } : {}),
  })

  // 系统工具（agent_*/bus_*/context_* + access_reply）。
  await kernel.registerSystemTools(tools)
  // 宿主工具（shell 内置：read/write/edit/grep/glob 等）。
  for (const tool of deps.hostTools ?? []) await tools.register(tool)

  // bash 工具（internal；宿主注入 ShellRunner 才装配——core 零平台依赖）。
  if (deps.shellRunner) {
    await tools.register(
      createBashTool({ runner: deps.shellRunner, ...(config.bash !== undefined ? { settings: config.bash } : {}) }),
    )
  }

  // skill 工具（internal，类配置显式暴露；发现走 init 生命周期）。
  await tools.register(createSkillTool({ skills }))

  // init 管线：扫描 .stem/tools + .stem/agent + .stem/context → 注册进 core（目录即真相，不回写 config）。
  const init = await runInit({
    config: { store: deps.config.store, paths: deps.config.paths },
    fs: deps.fs,
    tools: { loadTool: deps.tools.loadTool },
    toolRegistry: tools,
    templateRegistry: kernel.templates,
    strategyRegistry: kernel.contextManager.strategies,
    ...(deps.logger !== undefined ? { onLog: { log: (event) => deps.logger!.log(event) } } : {}),
  })

  // Pilot（user0 扮演接口）：pilot 初始化内实例化根 agent user0（user 类，普通实例）。
  const pilot = await createPilot({ kernel })
  if (deps.onEvent) pilot.subscribe(deps.onEvent)

  // 工具初始化生命周期（skill 发现等）。
  await tools.initAll({
    fs: deps.fs,
    skills,
    skillDir: skillDirOf(deps.config.paths),
    ...(deps.logger !== undefined ? { log: { log: (event) => deps.logger!.log(event) } } : {}),
  })

  const system: StemSystem = {
    kernel,
    pilot,
    tools,
    config,
    init,
    dispose: async () => {
      kernel.abortAllAgents()
      deps.stateStore?.messages.close?.()
      deps.stateStore?.instances.close?.()
    },
  }

  // 用户注入钩子（init 末尾）。
  for (const hook of deps.userHooks ?? []) await hook(system)

  return system
}

function skillDirOf(paths: ConfigPaths): string {
  return `${paths.configDir.replace(/[/\\]+$/, '')}/skills`
}

/** config.context → 策略运行时 ContextSettings（逐项兜底默认；无配置块 = undefined 走内置）。 */
function settingsOf(config: StemConfig): import('../context').ContextSettings | undefined {
  const ctx = config.context
  if (ctx === undefined) return undefined
  const d = DEFAULT_CONTEXT_SETTINGS
  return {
    window: ctx.window ?? d.window,
    compact: {
      enabled: ctx.compact?.enabled ?? d.compact.enabled,
      threshold: ctx.compact?.threshold ?? d.compact.threshold,
      keepRecentTurns: ctx.compact?.keepRecentTurns ?? d.compact.keepRecentTurns,
      replyTimeoutMs: ctx.compact?.replyTimeoutMs ?? d.compact.replyTimeoutMs,
      ...(ctx.compact?.instruction !== undefined ? { instruction: ctx.compact.instruction } : {}),
      ...(ctx.compact?.summarizeModel !== undefined ? { summarizeModel: ctx.compact.summarizeModel } : {}),
    },
  }
}