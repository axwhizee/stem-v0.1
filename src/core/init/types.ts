// ============================================================
// core/init/types.ts —— 初始化管线领域类型（纯 TS，零平台依赖）
//
// 管线职责（本阶段）：
//   1. 读取唯一配置（ConfigStore）；
//   2. 扫描 `.stem/tools/`、`.stem/agent/`、`.stem/context/` 目录
//     （**目录即真相**——S4.2 起不再维护 config 镜像注册表）；
//   3. 注册到 core（工具注册表 + TemplateRegistry + 策略注册表）。
// 平台能力（fs / 动态 import）全部由宿主注入。
// ============================================================

import type { AgentClass } from '../kernel'
import type { ToolCapability } from '../tools'

/** 文件系统能力（宿主注入：node fs / VSCode fs 等）。 */
export interface InitFs {
  /** 列出目录下的文件（相对或绝对路径均可）。 */
  readonly listFiles: (dir: string) => Promise<readonly string[]>
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
  /** 工具注册表（注册用户工具）。 */
  readonly toolRegistry: import('../tools').ToolCapabilityRegistry
  /** 模板注册表（注册用户 agent 类）。 */
  readonly templateRegistry: import('../kernel').TemplateRegistry
  /** 上下文策略注册表（注册用户 `.stem/context/` 策略；可选）。 */
  readonly strategyRegistry?: import('../context').StrategyRegistry
  /** 日志出口（组合根注入 → bus → core/logging）。 */
  readonly onLog?: import('../logging').LogSink
}

/** 初始化过程发现的问题（不致命，记录后继续）。 */
export type InitIssue =
  | { readonly kind: 'tool_load_failed'; readonly file: string; readonly message: string }
  | { readonly kind: 'tool_invalid'; readonly file: string; readonly message: string }
  | { readonly kind: 'agent_parse_failed'; readonly file: string; readonly message: string }
  | { readonly kind: 'agent_invalid'; readonly file: string; readonly message: string }
  | { readonly kind: 'strategy_load_failed'; readonly file: string; readonly message: string }
  | { readonly kind: 'strategy_invalid'; readonly file: string; readonly message: string }

/** 扫描发现的目录条目（目录即真相；报告只作展示/日志，不再回写 config）。 */
export interface DiscoveredEntry {
  readonly id: string
  readonly file: string
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

/** 初始化错误（致命，直接中断）。 */
export type InitError =
  | { readonly kind: 'config_parse_error'; readonly message: string }
  | { readonly kind: 'tool_registration_failed'; readonly message: string }
  | { readonly kind: 'agent_registration_failed'; readonly message: string }
