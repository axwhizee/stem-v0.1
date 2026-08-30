// ============================================================
// shell/cli/platform.ts —— 节点平台装配（供各 shell 复用）
//
// cli 是最精简的参考 shell：导出节点平台能力（config/fs/网关/宿主工具）
// 与系统装配入口 bootStem。其它 shell（webui 等）可直接复用，
// 无需研究 core 接口即可完成引导。
// ============================================================

import { join } from 'node:path'
import { createNodeConfigBundle, FALLBACK_MODEL } from './config'
import { createHostTools } from './tools'
import { buildGateway } from './gateway'
import { createSqliteStateStore } from './storage'
import { createStemSystem, type StemSystemDeps, type UserInitHook } from '../../src/core/init'
import type { StemSystem } from '../../src/core/init'
import { parseModelRef } from '../../src/core/config'
import type { PilotEvent } from '../../src/core/events'
import type { ToolCapability } from '../../src/core/tools'
import { makeAgentClassID } from '../../src/core/kernel'
import type { Kernel } from '../../src/core/kernel'

export { createHostTools }

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
  /** 宿主工具（缺省 = fs 工具集 read/write/edit/grep/glob）。 */
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
}

export interface BootResult {
  readonly system: StemSystem
  readonly source: string
  readonly projectRoot: string
  /** 生效的持久化存储（undefined = 纯内存）。 */
  readonly stateStore?: StemSystemDeps['stateStore']
}

/** 节点平台装配：读取配置 → 构建网关 → createStemSystem（含 user0 实例化 + SQLite 恢复）。 */
export async function bootStem(opts: BootOptions): Promise<BootResult> {
  const bundle = createNodeConfigBundle(opts.projectRoot)
  const loaded = await bundle.store.load()
  const model = parseModelRef(loaded.config.model, FALLBACK_MODEL)
  const { gateway, source } = await buildGateway(model.id)
  const stateStore = opts.stateStore === false ? undefined : (opts.stateStore ?? createSqliteStateStore(defaultDbFile(opts.projectRoot)))
  const system = await createStemSystem({
    config: { store: bundle.store, paths: bundle.paths },
    fs: bundle.fs,
    tools: { loadTool: bundle.loadTool },
    gateway,
    defaultModel: model,
    hostTools: opts.hostTools ?? createHostTools(opts.projectRoot),
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