// ============================================================
// core/config/types.ts —— 全局配置领域类型（纯 TS，零平台依赖）
//
// 配置模式（与 opencode 不同）：**唯一配置文件** `.stem/stem.jsonc`
// （或 `.stem/stem.json`）是最终配置载体，全量存储所有可配置项；
// 本阶段不引入 `~/.config/stem/` 多级合并。
//
// 同步注册表（tools/agents）：
//   - 由 `core/init` 自动维护的**纯镜像**——扫描 `.stem/tool/`、`.stem/agent/`
//     目录，发现文件就登记，缺实现文件就移除，用户不应手工编辑。
//   - `model` 采用 opencode 格式 `提供商/模型`（如 `opencode-go/deepseek-v4-flash`）。
// ============================================================

import type { ToolAccess } from '../tools'

/** 已注册的用户工具条目（纯镜像，init 自动维护）。 */
export interface RegisteredTool {
  /** 工具 id（与实现文件导出的 ToolCapability.id 同名）。 */
  readonly id: string
  /** 相对 `.stem/` 目录的实现文件路径，如 `tool/foo.ts`。 */
  readonly file: string
  /** 工具来源：user = 用户提供（`.stem/tool/`）。 */
  readonly kind: 'user'
  /** 是否启用（镜像保留；后续用户覆盖 enabled 时使用）。 */
  readonly enabled: boolean
}

/** 已注册的用户 agent 条目（纯镜像，init 自动维护）。 */
export interface RegisteredAgent {
  /** agent 类 id（YAML 头 id 或文件名兜底）。 */
  readonly id: string
  /** 相对 `.stem/` 目录的实现文件路径，如 `agent/foo.md`。 */
  readonly file: string
}

/**
 * 全局配置（`.stem/stem.jsonc` 的内容形状）。
 * 所有字段可选——读取时逐项兜底为默认值。
 */
export interface StemConfig {
  /** 当前使用的模型（opencode 格式 `提供商/模型`）。 */
  readonly model?: string
  /** 是否开启权限自动批准（true 时 ask 直接放行，不弹窗）。 */
  readonly autoApprove?: boolean
  /**
   * 工具权限设置 = **user 模板（内置根类）的 tools 清单**：user0（元 agent）的
   * 能力面，也是整棵族谱的祖先链首层。生效权限 = 祖先链（含 user0 根）→
   * 类清单 → session 批准，层间单调收缩；未列出的工具落到默认（internal 默认
   * ignore 隐藏，其余 ask）。
   */
  readonly permission?: Readonly<Record<string, ToolAccess>>
  /** 全局默认送信倒计时（毫秒；agent 文件/类未指定时使用）。 */
  readonly sendCountdown?: number
  /** 已注册的用户工具（纯镜像，init 自动维护）。 */
  readonly tools?: readonly RegisteredTool[]
  /** 已注册的用户 agent（纯镜像，init 自动维护）。 */
  readonly agents?: readonly RegisteredAgent[]
  /** 用户自定义扩展配置（透传保留）。 */
  readonly custom?: Readonly<Record<string, unknown>>
}

/** 配置解析结果（区分文件是否存在）。 */
export interface ConfigLoadResult {
  /** 配置文件是否存在。 */
  readonly exists: boolean
  /** 解析出的配置（缺省填充默认值）。 */
  readonly config: StemConfig
  /** 原始文本（存在时）。 */
  readonly raw?: string
}

/** 配置错误（判别联合，code-style §4.1）。 */
export type ConfigError =
  | { readonly kind: 'config_parse_error'; readonly message: string; readonly file?: string }
  | { readonly kind: 'config_file_not_found'; readonly file: string }
  | { readonly kind: 'invalid_config'; readonly message: string }
