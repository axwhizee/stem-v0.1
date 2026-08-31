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
import type { ModelRef } from '../gateway'

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

/** 已注册的用户上下文策略条目（纯镜像，init 自动维护）。 */
export interface RegisteredStrategy {
  /** 策略名（ContextStrategyModule.name，AgentClass.contextStrategy 引用）。 */
  readonly id: string
  /** 相对策略目录的实现文件路径，如 `foo.ts`。 */
  readonly file: string
}

/**
 * user0 内嵌 agent 类完整配置（`config.user`——元 agent 单独处理为对象）。
 * 与 AgentClass 形状同构（name 固定 'user' 不可配，防命名空间入侵）：
 * user0 = user 类的普通实例，其"人格"（权限面/提示词/倒计时/模型/策略）
 * 全部声明式可配，缺省走内置默认（DEFAULT_USER_* 见 kernel/userClass）。
 */
export interface StemUserClass {
  readonly description?: string
  readonly systemPrompt?: string
  /**
   * 工具权限清单 = user 类 tools（键即白名单：未列出的工具对 user0 一律
   * deny；对子孙则只供显式判定——缺席 ≠ 否决，显式 deny/ask 锁子孙）。
   * 给出则**整表替换**内置默认（含 access_reply 等根义务面，慎删）。
   */
  readonly permission?: Readonly<Record<string, ToolAccess>>
  /** 上下文管理策略（user0 面板态默认不消费，pilot 未来 as() 扩展预留）。 */
  readonly contextStrategy?: string
  /** 模型偏好（解析 `提供商/模型` 字符串）。 */
  readonly model?: ModelRef
  /** 送信倒计时毫秒（缺省 0 = 直接获得回复）。 */
  readonly sendCountdown?: number
}

/** 上下文策略配置块（`config.context`；classic 的 compact 参数面）。 */
export interface StemContextConfig {
  /** prompt 预算（估算 token，字符/4 口径）。 */
  readonly window?: number
  readonly compact?: {
    readonly enabled?: boolean
    /** 触发阈值（估算 token 占 window 比例，0~1）。 */
    readonly threshold?: number
    /** 保留最近轮数。 */
    readonly keepRecentTurns?: number
    /** 摘要 worker 模型（`提供商/模型`；缺省系统默认）。 */
    readonly summarizeModel?: ModelRef
    /** 摘要指令覆盖（缺省 classic 内置模板）。 */
    readonly instruction?: string
    /** 等待摘要 worker 回信超时毫秒。 */
    readonly replyTimeoutMs?: number
  }
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
  /** user0 内嵌 agent 类完整配置（元 agent = 族谱根 = 全局权限首层）。 */
  readonly user?: StemUserClass
  /** 单轮 LLM 循环最大步数（含工具轮；缺省 5）。 */
  readonly maxSteps?: number
  /** 上下文策略配置（window/compact）。 */
  readonly context?: StemContextConfig
  /** 全局默认送信倒计时（毫秒；agent 文件/类未指定时使用）。 */
  readonly sendCountdown?: number
  /** 已注册的用户工具（纯镜像，init 自动维护）。 */
  readonly tools?: readonly RegisteredTool[]
  /** 已注册的用户 agent（纯镜像，init 自动维护）。 */
  readonly agents?: readonly RegisteredAgent[]
  /** 已注册的用户上下文策略（纯镜像，init 自动维护）。 */
  readonly strategies?: readonly RegisteredStrategy[]
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
