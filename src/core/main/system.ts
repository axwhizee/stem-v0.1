// ============================================================
// core/main/system.ts —— createStemSystem（系统初始化与装配主入口；组合根）
//
// 目标形态（docs/architecture.md 2.8）：
//   Ⅰ stem 初始化：空间定位（deps.config.paths）→ config 解析 → 参数落位
//      → 资源发现（runInit：工具入无序清单；类/策略入注册表）
//   Ⅱ Kernel 构造（工具表尚空；internal execute 经端口用到 Kernel）
//   Ⅲ 工具 drain：seed = internal 定义 + hostTools + 发现清单 + 策略 ownedTools
//      while (队列) { register + init }；init 可 registerMore；完成后冻结
//   Ⅳ wireRestoredContexts → Ⅴ Pilot/user#0 → Ⅵ boot 校验律 → Ⅶ userHooks
//
// 策略不参与 boot 编排：无策略 init、无 registerTool。
// ============================================================

import type { ConfigError, ConfigPaths, ConfigStore, StemConfig } from '../config'
import { defaultStemConfig, agentFileOf, serializeAgentClass } from '../config'
import type { ModelGateway, UsageEvent } from '../gateway'
import type { Logger } from '../logging'
import type { MessageStore, TimerFactory } from '../context'
import { DEFAULT_CONTEXT_SETTINGS, type StrategyInitFs } from '../context'
import type { InstanceStore } from '../kernel'
import type { ClassStore } from '../kernel'
import type { ToolCapability, ToolCapabilityRegistry } from '../tools'
import { DefaultToolCapabilityRegistry } from '../tools'
import type { ShellRunner } from '../tools'
import { Kernel, ROOT_ID } from '../kernel'
import type { Pilot } from '../pilot'
import { createPilot } from '../pilot'
import type { PilotEvent } from '../events'
import { runInit } from './loader'
import type { InitDeps, InitReport, ClassFs } from './types'
import { createRuntime } from './runtime'
import { createSystemFacade } from './systemFacade'
import { createInternalToolDefs, attachToolRecordSink } from './toolWiring'

/** 系统上下文（用户注入钩子入参）。 */
export interface StemSystem {
  readonly kernel: Kernel
  /** 根（user#0）扮演接口（外部交互核心）。 */
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
  /** 宿主显式注入的工具（随 drain seed 入表）。 */
  readonly hostTools?: readonly ToolCapability[]
  readonly extensionRoots?: InitDeps['extensionRoots']
  /** shell 执行端口（注入后装配 bash）。 */
  readonly shellRunner?: ShellRunner
  /** 类回写文件端口（进化书写面）。 */
  readonly classFs?: ClassFs
  readonly userHooks?: readonly UserInitHook[]
  readonly onEvent?: (event: PilotEvent) => void
  readonly stateStore?: { readonly messages: MessageStore; readonly instances: InstanceStore }
}

export async function createStemSystem(deps: StemSystemDeps): Promise<StemSystem> {
  // ---- Ⅰ stem 初始化：config ----
  const loaded = await deps.config.store.load()
  const config = loaded.exists ? loaded.config : defaultStemConfig()
  if (config.user?.model === undefined) {
    throw {
      kind: 'invalid_config',
      message:
        'user.model 必填（user 类 model 基因；模板默认 "opencode-go/deepseek-v4-flash"，请在 .stem/stem.jsonc 的 user.model 补全）',
    } as ConfigError
  }

  const tools = new DefaultToolCapabilityRegistry()
  const settings = settingsOf(config)
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

  // ---- Ⅱ Kernel 构造（工具表尚空）----
  const kernel = new Kernel({
    gateway: deps.gateway,
    runtime: createRuntime,
    userClass: config.user,
    project: deps.config.paths.projectRoot,
    tools,
    defaultCountdownMs: config.sendCountdown,
    autoApprove: config.autoApprove,
    timer: deps.timer,
    ...(config.tools?.outputLimit !== undefined ? { toolOutputLimit: config.tools.outputLimit } : {}),
    estimateCost: deps.estimateCost,
    logger: deps.logger,
    ...(settings !== undefined ? { contextSettings: settings } : {}),
    ...(deps.stateStore !== undefined ? { stateStore: deps.stateStore } : {}),
    ...(classStore !== undefined ? { classStore } : {}),
  })
  attachToolRecordSink(kernel, tools, config.tools?.outputLimit)

  // ---- Ⅰ 续：资源发现（类/策略入注册表；工具只入无序清单）----
  const strategyFs: StrategyInitFs = {
    listFiles: (dir) => deps.fs.listFiles(dir).catch(() => []),
    readText: (file) => deps.fs.readText(file),
    ...(deps.classFs !== undefined
      ? {
          writeText: (file: string, content: string) => deps.classFs!.writeText(file, content),
          ensureDir: (dir: string) => deps.classFs!.ensureDir(dir),
        }
      : {}),
  }
  const init = await runInit({
    config: { store: deps.config.store, paths: deps.config.paths },
    fs: deps.fs,
    tools: { loadTool: deps.tools.loadTool },
    ...(deps.extensionRoots !== undefined ? { extensionRoots: deps.extensionRoots } : {}),
    templateRegistry: kernel.templates,
    strategyRegistry: kernel.contextManager.strategies,
    ...(deps.logger !== undefined ? { onLog: { log: (event) => deps.logger!.log(event) } } : {}),
  })
  const issues: import('./types').InitIssue[] = [...init.issues]

  // 策略自带工具（注册表全量，含内置）：发现段物化并入 seed。
  const strategySeed: ToolCapability[] = []
  for (const name of kernel.contextManager.strategies.names()) {
    const module = kernel.contextManager.strategies.resolve(name)
    if (!module) continue
    try {
      if (module.createOwnedTools !== undefined) {
        strategySeed.push(
          ...module.createOwnedTools({
            projectRoot: deps.config.paths.projectRoot,
            settings: settings ?? DEFAULT_CONTEXT_SETTINGS,
            fs: strategyFs,
          }),
        )
      } else if (module.ownedTools !== undefined) {
        strategySeed.push(...module.ownedTools)
      }
    } catch (cause) {
      issues.push({
        kind: 'strategy_invalid',
        file: name,
        message: `createOwnedTools 失败：${cause instanceof Error ? cause.message : String(cause)}`,
      })
    }
  }

  // ---- Ⅲ 工具 drain（唯一初始化执行面）----
  const internalDefs = createInternalToolDefs(kernel, {
    ...(deps.shellRunner !== undefined
      ? {
          bash: {
            runner: deps.shellRunner,
            settings: { ...(config.bash ?? {}), cwd: config.bash?.cwd ?? deps.config.paths.projectRoot },
          },
        }
      : {}),
  })
  const seed: ToolCapability[] = [...internalDefs, ...(deps.hostTools ?? []), ...init.toolInventory, ...strategySeed]
  const drainIssues = await tools.drain(seed, {
    fs: deps.fs,
    projectRoot: deps.config.paths.projectRoot,
    ...(deps.logger !== undefined ? { log: { log: (event) => deps.logger!.log(event) } } : {}),
  })
  for (const issue of drainIssues) {
    issues.push({ kind: 'tool_init_failed', file: issue.tool, message: issue.message })
  }
  const initReport: InitReport = { ...init, issues, toolInventory: seed }

  // ---- Ⅳ 恢复接线 ----
  await kernel.wireRestoredContexts()

  // ---- Ⅴ Pilot / user#0 ----
  const pilot = await createPilot({ facade: createSystemFacade(kernel) })
  if (deps.onEvent) pilot.subscribe(deps.onEvent)

  // ---- Ⅵ boot 校验律 ----
  const replyExplicit = kernel.lineage.effectiveAccess(ROOT_ID, 'access_reply')
  const replyAccess = replyExplicit ?? tools.registerAccessOf('access_reply')
  if (replyAccess !== 'allow') {
    throw {
      kind: 'invalid_config',
      message:
        `boot 校验律：根（user#0）生效 access_reply = ${String(replyAccess)}，必须为 allow——` +
        'ask 审批经 access_request→根信箱→access_reply 消息交换闭环，根答复缺位 = 权限系统死锁。' +
        '请在 .stem/stem.jsonc 的 user.tools 补 "access_reply": "allow"（首启模板含推荐清单实值）。',
    } as ConfigError
  }

  const system: StemSystem = {
    kernel,
    pilot,
    tools,
    config,
    init: initReport,
    dispose: async () => {
      await kernel.drainForShutdown()
      await tools.disposeAll()
      deps.stateStore?.messages.close?.()
      deps.stateStore?.instances.close?.()
    },
  }

  // ---- Ⅶ userHooks ----
  for (const hook of deps.userHooks ?? []) await hook(system)

  return system
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
