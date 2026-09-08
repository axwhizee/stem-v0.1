// ============================================================
// shell/cli/platform.ts —— 节点平台装配（供各 shell 复用）
//
// cli 是最精简的参考 shell：导出节点平台能力（config/fs/网关/存储/bash）
// 与系统装配入口 bootStem。其它 shell（webui 等）可直接复用，
// 无需研究 core 接口即可完成引导。
// extension 资源装载已归位 init 管线（S7 三维矩阵）：本文件只给出
// extension 根路径（仓库 extension/），config.extensions 点名启用。
// ============================================================

import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createNodeConfigBundle } from './config'
import { createNodeShellRunner } from './bash'
import { buildGateway } from './gateway'
import { createSqliteStateStore } from './storage'
import { createStemSystem, type StemSystemDeps, type UserInitHook } from '../../src/core/init'
import type { StemSystem } from '../../src/core/init'
import { defaultStemConfig } from '../../src/core/config'
import type { PilotEvent } from '../../src/core/events'
import type { ShellRunner, ToolCapability } from '../../src/core/tools'

/**
 * 仓库 extension 资源根（S7 矩阵 extension 层）：<repo>/extension/{tools,agent,context}。
 * 发布镜像与源码直跑同构（COPY extension/ 进镜像，见 Dockerfile）。
 */
export function extensionRoots(): StemSystemDeps['extensionRoots'] {
  const base = fileURLToPath(new URL('../../extension/', import.meta.url))
  return {
    tools: join(base, 'tools'),
    agent: join(base, 'agent'),
    context: join(base, 'context'),
  }
}

export interface BootOptions {
  /** 项目根（含 .stem/ 配置）。 */
  readonly projectRoot: string
  /** 宿主工具（显式注入通道，测试/深度定制用；常规 extension 工具走 config.extensions 点名）。 */
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

/** 节点平台装配：读取配置 → 构建网关（providers 路由）→ createStemSystem（根实例化 + SQLite 恢复）。 */
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
      : (opts.stateStore ?? createSqliteStateStore(defaultDbFile(opts.projectRoot)))
  const shellRunner = opts.shellRunner === false ? undefined : (opts.shellRunner ?? createNodeShellRunner({ defaultCwd: opts.projectRoot }))
  const system = await createStemSystem({
    config: { store: bundle.store, paths: bundle.paths },
    fs: bundle.fs,
    classFs: bundle.classFs,
    tools: { loadTool: bundle.loadTool },
    gateway,
    extensionRoots: extensionRoots(),
    ...(opts.hostTools !== undefined ? { hostTools: opts.hostTools } : {}),
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