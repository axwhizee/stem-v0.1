// ============================================================
// core/config/types.ts —— 全局配置领域类型（纯 TS，零平台依赖）
//
// 配置模式（与 opencode 不同）：**唯一配置文件** `.stem/stem.jsonc`
// （或 `.stem/stem.json`）是最终配置载体，全量存储所有可配置项；
// 本阶段不引入 `~/.config/stem/` 多级合并。
//
// **目录即真相**（S4.2）：用户工具/agent/策略的注册表就是
//   `.stem/tools/`、`.stem/agent/`、`.stem/context/` 目录本身——
//   不再有 config 镜像字段（旧 tools/agents/strategies 键已删除，
//   出现于旧配置时被忽略）。
//   - `model` 采用 opencode 格式 `提供商/模型`（如 `opencode-go/deepseek-v4-flash`）。
// ============================================================

import type { ToolAccess } from '../tools'
import type { ModelRef } from '../gateway'

/**
 * user0 内嵌 agent 类完整配置（`config.user`——元 agent 单独处理为对象）。
 * 与 AgentClass 形状同构（name 固定 'user' 不可配，防命名空间入侵）：
 * user0 = user 类的普通实例，其"人格"（工具清单/提示词/倒计时/模型/策略）
 * 全部声明式可配，缺省走内置默认（DEFAULT_USER_* 见 kernel/userClass）。
 */
export interface StemUserClass {
  readonly description?: string
  readonly systemPrompt?: string
  /**
   * 工具清单 = user 类 tools（键即白名单：未列出的工具对 user0 一律
   * deny；对子孙则只供显式判定——缺席 ≠ 否决，显式 deny = 铁律锁子孙）。
   * 给出则**整表替换**内置默认（含 access_reply 根义务与 bash 操作面，慎删）。
   */
  readonly tools?: Readonly<Record<string, ToolAccess>>
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

/** bash 工具配置块（`config.bash`——core 侧仅 defaultTimeoutMs/maxOutputChars/cwd 参与工具成形，path 透传给宿主 runner）。 */
export interface StemBashConfig {
  /** shell 二进制路径（缺省由宿主定，典型 'bash'）。 */
  readonly path?: string
  /** 缺省硬超时毫秒（工具参数 timeoutMs 可逐次覆盖）。 */
  readonly defaultTimeoutMs?: number
  /** stdout/stderr 各自截断上限（字符）。 */
  readonly maxOutputChars?: number
  /** 缺省工作目录（相对项目根由宿主解释；缺省 = 项目根）。 */
  readonly cwd?: string
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
  /** bash 工具配置（超时/输出上限/shell 路径/缺省目录）。 */
  readonly bash?: StemBashConfig
  /** 全局默认送信倒计时（毫秒；agent 文件/类未指定时使用）。 */
  readonly sendCountdown?: number
  /**
   * 启用的宿主 tool_set 包 id（如 `["fs"]`；`[]` = 纯 bash 最小系统）。
   * core 只透传字符串清单，解析加载由宿主装配层完成（缺省由宿主兜底）。
   */
  readonly extensions?: readonly string[]
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
