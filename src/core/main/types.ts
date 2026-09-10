// ============================================================
// core/main/types.ts —— 组合/装载管线领域类型（纯 TS，零平台依赖）
//
// 管线职责（S7 三维资源矩阵）：
//   1. 读取唯一配置（ConfigStore）；
//   2. 统一装载 tools / agent 类 / context 策略三类资源：
//      extension 层 = config.extensions 点名 + `extension/<种类>/<名>/` 目录形态；
//      custom 层 = `.stem/` 自动扫描（目录即真相，平铺 + 目录双形态）；
//   3. 注册到 core（后层同名覆盖前层；平台能力 fs/import 全由宿主注入）。
// ============================================================

import type { AgentClass } from '../kernel'
import type { ToolCapability } from '../tools'

/** 文件系统能力（宿主注入：node fs / VSCode fs 等）。 */
export interface InitFs {
  /** 列出目录下的文件（相对或绝对路径均可）。 */
  readonly listFiles: (dir: string) => Promise<readonly string[]>
  /** 列出目录下的直接子目录（三维矩阵目录形态资源发现；缺失目录 = []）。 */
  readonly listDirs: (dir: string) => Promise<readonly string[]>
  /** 读取文本文件。 */
  readonly readText: (file: string) => Promise<string>
}

/**
 * 动态模块加载器（宿主注入：node 动态 import；tsx 环境可加载 .ts）。
 * loadTool 为通用「默认导出模块导入」——用户工具（ToolCapability）与
 * 用户上下文策略（ContextStrategyModule）共用，差异只在管线校验形状。
 */
export interface InitToolLoader {
  /** 加载模块文件，返回其 default 导出（ToolCapability / ContextStrategyModule 形状）。 */
  readonly loadTool: (file: string) => Promise<{ readonly default?: unknown }>
}

/**
 * 类回写文件端口（S5.2 进化书写面；宿主注入，InitFs 只有读能力故单列）。
 * createStemSystem 装成 Kernel 的 ClassStore：serialize → ensureDir → writeText。
 */
export interface ClassFs {
  readonly ensureDir: (dir: string) => Promise<void>
  readonly writeText: (file: string, content: string) => Promise<void>
}

/** 初始化管线依赖（组合根装配）。 */
export interface InitDeps {
  readonly config: {
    /** 配置存储（读 + 写）。 */
    readonly store: import('../config').ConfigStore
    /** 配置目录结构（projectRoot / toolDir / agentDir）。 */
    readonly paths: import('../config').ConfigPaths
  }
  readonly fs: InitFs
  readonly tools: InitToolLoader
  /**
   * extension 资源根（S7 矩阵；宿主注入仓库 `extension/` 各资源目录的绝对路径）。
   * 缺省 = 无 extension 层（config.extensions 点名会逐项记 issue）。
   */
  readonly extensionRoots?: {
    readonly tools?: string
    readonly agent?: string
    readonly context?: string
  }
  /** 工具注册表（注册用户工具）。 */
  readonly toolRegistry: import('../tools').ToolCapabilityRegistry
  /** 模板注册表（注册用户 agent 类）。 */
  readonly templateRegistry: import('../kernel').TemplateRegistry
  /** 上下文策略注册表（注册用户 `.stem/context/` 策略；可选）。 */
  readonly strategyRegistry?: import('../context').StrategyRegistry
  /** 日志出口（组合根注入 → bus → core/logging）。 */
  readonly onLog?: import('../logging').LogSink
}

/** extension 条目装载中间形状（loadExtensionEntry 产物：文件 + 默认导出/文本）。 */
export interface ResourceEntry {
  readonly name: string
  readonly file: string
  /** .ts 条目 = 模块 default 导出；.md 条目 = 文件全文。 */
  readonly module: unknown
}

/** 初始化过程发现的问题（不致命，记录后继续）。 */
export type InitIssue =
  | { readonly kind: 'tool_load_failed'; readonly file: string; readonly message: string }
  | { readonly kind: 'tool_invalid'; readonly file: string; readonly message: string }
  | { readonly kind: 'agent_parse_failed'; readonly file: string; readonly message: string }
  | { readonly kind: 'agent_invalid'; readonly file: string; readonly message: string }
  | { readonly kind: 'strategy_load_failed'; readonly file: string; readonly message: string }
  | { readonly kind: 'strategy_invalid'; readonly file: string; readonly message: string }
  | { readonly kind: 'extension_entry_missing'; readonly file: string; readonly message: string }

/** 扫描发现的目录条目（目录即真相；报告只作展示/日志，不再回写 config）。 */
export interface DiscoveredEntry {
  readonly id: string
  readonly file: string
  /** 来源层（extension 点名 / custom 目录即真相；矩阵 internal 层不经本管线）。 */
  readonly layer: 'extension' | 'custom'
}

/** 初始化报告。 */
export interface InitReport {
  /** 扫描发现的用户工具（目录 = `.stem/tools/`）。 */
  readonly tools: readonly DiscoveredEntry[]
  /** 扫描发现的用户 agent 类（目录 = `.stem/agent/`）。 */
  readonly agents: readonly DiscoveredEntry[]
  /** 扫描发现的用户上下文策略（目录 = `.stem/context/`）。 */
  readonly strategies: readonly DiscoveredEntry[]
  /** 成功注册的用户工具（ToolCapability 对象）。 */
  readonly registeredTools: readonly ToolCapability[]
  /** 成功注册的用户 agent 类。 */
  readonly registeredAgents: readonly AgentClass[]
  /** 初始化过程中发现的问题。 */
  readonly issues: readonly InitIssue[]
}

/** 初始化错误（致命，直接中断——boot 校验律的执行面）。 */
export type InitError =
  | { readonly kind: 'config_parse_error'; readonly message: string }
  | { readonly kind: 'tool_registration_failed'; readonly message: string }
  | { readonly kind: 'tool_unresolvable'; readonly message: string; readonly file?: string }
  | { readonly kind: 'agent_registration_failed'; readonly message: string }
