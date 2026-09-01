// ============================================================
// shell/cli/platform.ts —— 节点平台装配（供各 shell 复用）
//
// cli 是最精简的参考 shell：导出节点平台能力（config/fs/网关/宿主工具）
// 与系统装配入口 bootStem。其它 shell（webui 等）可直接复用，
// 无需研究 core 接口即可完成引导。
// ============================================================

import { join } from 'node:path'
import { createNodeConfigBundle } from './config'
import { createHostTools } from './tools'
import { createNodeShellRunner } from './bash'
import { buildGateway } from './gateway'
import { createSqliteStateStore } from './storage'
import { createStemSystem, type StemSystemDeps, type UserInitHook } from '../../src/core/init'
import type { StemSystem } from '../../src/core/init'
import { defaultStemConfig } from '../../src/core/config'
import type { PilotEvent } from '../../src/core/events'
import type { ShellRunner, ToolCapability } from '../../src/core/tools'
import { makeAgentClassID } from '../../src/core/kernel'
import type { Kernel } from '../../src/core/kernel'

export { createHostTools }

/**
 * 宿主 tool_set 清单（config.extensions 的 id → 工具工厂）。
 * core 对 id 语义无感知（只透传字符串数组）；fs 参考实现暂驻 shell/cli/tools
 * （最小变体：目录不动），第三方 tool_set 未来在 extension/tools/ 落位并入本表。
 */
const TOOL_SETS: Readonly<Record<string, (root: string) => readonly ToolCapability[]>> = {
  fs: (root) => createHostTools(root),
}

/** config.extensions 缺省值（键不存在时）= 装载 fs 包；显式 [] = 纯 bash 最小系统。 */
const DEFAULT_EXTENSIONS: readonly string[] = ['fs']

/** 解析 config.extensions → 宿主工具清单（未知 id 告警跳过，不炸启动）。 */
export function resolveToolSets(extIds: readonly string[] | undefined, root: string): ToolCapability[] {
  const tools: ToolCapability[] = []
  for (const id of extIds ?? DEFAULT_EXTENSIONS) {
    const factory = TOOL_SETS[id]
    if (!factory) {
      console.warn(`[stem] 未知 extension "${id}"（可用：${Object.keys(TOOL_SETS).join(', ')}），已跳过`)
      continue
    }
    tools.push(...factory(root))
  }
  return tools
}

/** 示例模板注册钩子（参考 shell 共享）：tool-assistant（带工具）+ creator（调度者）。 */
export const demoTemplatesHook: UserInitHook = async ({ kernel }: { kernel: Kernel }) => {
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
}

export interface BootOptions {
  /** 项目根（含 .stem/ 配置）。 */
  readonly projectRoot: string
  /** 宿主工具（显式覆盖；缺省 = 按 config.extensions 解析 tool_set，未写键 = ["fs"]）。 */
  readonly hostTools?: readonly ToolCapability[]
  /** 事件流回调（PilotEvent；pilot 创建后订阅）。 */
  readonly onEvent?: (event: PilotEvent) => void
  /** 用户注入钩子（init 末尾调用）。 */
  readonly userHooks?: readonly UserInitHook[]
  /**
   * 个体层持久化（缺省 = SQLite：`STEM_DB_PATH` 或 `<projectRoot>/.stem/stem.db`）；
   * `false` = 显式纯内存运行（不落盘）。
   */
  readonly stateStore?: StemSystemDeps['stateStore'] | false
  /** shell 执行端口（缺省 = node child_process，cwd=项目根；`false` = 不装配 bash）。 */
  readonly shellRunner?: ShellRunner | false
}

export interface BootResult {
  readonly system: StemSystem
  readonly source: string
  readonly projectRoot: string
  /** 生效的持久化存储（undefined = 纯内存）。 */
  readonly stateStore?: StemSystemDeps['stateStore']
}

/** 节点平台装配：读取配置 → 构建网关（providers 路由）→ createStemSystem（user0 实例化 + SQLite 恢复）。 */
export async function bootStem(opts: BootOptions): Promise<BootResult> {
  const bundle = createNodeConfigBundle(opts.projectRoot)
  const loaded = await bundle.store.load()
  // S6/R12：配置文件不存在 = 首启，内存等效 = 首启模板解析产物（runInit 随后落盘同一文本）。
  const config = loaded.exists ? loaded.config : defaultStemConfig()
  const { gateway, source, warnings } = buildGateway(config, process.env)
  // R1 两段式第一段：key_env 未命中启动即 warn（不印值），用到才硬错。
  for (const warning of warnings) console.warn(`[stem] ${warning}`)
  const stateStore =
    opts.stateStore === false
      ? undefined
      : (opts.stateStore ?? createSqliteStateStore(defaultDbFile(opts.projectRoot), opts.projectRoot))
  const shellRunner = opts.shellRunner === false ? undefined : (opts.shellRunner ?? createNodeShellRunner({ defaultCwd: opts.projectRoot }))
  const system = await createStemSystem({
    config: { store: bundle.store, paths: bundle.paths },
    fs: bundle.fs,
    classFs: bundle.classFs,
    tools: { loadTool: bundle.loadTool },
    gateway,
    hostTools: opts.hostTools ?? resolveToolSets(config.extensions, opts.projectRoot),
    ...(shellRunner !== undefined ? { shellRunner } : {}),
    onEvent: opts.onEvent,
    userHooks: opts.userHooks,
    ...(stateStore !== undefined ? { stateStore } : {}),
  })
  return { system, source, projectRoot: opts.projectRoot, ...(stateStore !== undefined ? { stateStore } : {}) }
}

/** 默认 DB 位置：`STEM_DB_PATH` 覆盖；否则 `.stem/stem.db`（与配置同目录，随 volume 持久）。 */
function defaultDbFile(projectRoot: string): string {
  return process.env.STEM_DB_PATH ?? join(projectRoot, '.stem', 'stem.db')
}