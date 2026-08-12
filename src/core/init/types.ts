// ============================================================
// core/init/types.ts —— 初始化管线领域类型（纯 TS，零平台依赖）
//
// 管线职责（本阶段）：
//   1. 读取唯一配置（ConfigStore）；
//   2. 扫描 `.stem/tool/`、`.stem/agent/` 目录；
//   3. 同步注册表到 stem.jsonc（纯镜像：发现文件就登记、缺实现就移除）；
//   4. 注册到 core（工具注册表 + AgentTemplateRegistry）。
// 平台能力（fs / 动态 import）全部由宿主注入。
// ============================================================

import type { RegisteredAgent, RegisteredTool, StemConfig } from '../config'
import type { AgentClass } from '../kernel'
import type { ToolCapability } from '../tools'

/** 文件系统能力（宿主注入：node fs / VSCode fs 等）。 */
export interface InitFs {
  /** 列出目录下的文件（相对或绝对路径均可）。 */
  readonly listFiles: (dir: string) => Promise<readonly string[]>
  /** 读取文本文件。 */
  readonly readText: (file: string) => Promise<string>
}

/** 动态加载用户工具模块（宿主注入：node 动态 import 等）。 */
export interface InitToolLoader {
  /** 加载工具模块，返回其 default 导出（ToolCapability 形状）。 */
  readonly loadTool: (file: string) => Promise<{ readonly default?: unknown }>
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
  readonly templateRegistry: import('../kernel').AgentTemplateRegistry
  /** 日志出口（组合根注入 → bus → core/logging）。 */
  readonly onLog?: import('../logging').LogSink
}

/** 初始化过程发现的问题（不致命，记录后继续）。 */
export type InitIssue =
  | { readonly kind: 'tool_load_failed'; readonly file: string; readonly message: string }
  | { readonly kind: 'tool_invalid'; readonly file: string; readonly message: string }
  | { readonly kind: 'agent_parse_failed'; readonly file: string; readonly message: string }
  | { readonly kind: 'agent_invalid'; readonly file: string; readonly message: string }
  | { readonly kind: 'orphan_registration'; readonly type: 'tool' | 'agent'; readonly id: string; readonly file: string }

/** 初始化报告。 */
export interface InitReport {
  /** 同步后的配置。 */
  readonly config: StemConfig
  /** 同步后的注册表（tools 镜像）。 */
  readonly tools: readonly RegisteredTool[]
  /** 同步后的注册表（agents 镜像）。 */
  readonly agents: readonly RegisteredAgent[]
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
