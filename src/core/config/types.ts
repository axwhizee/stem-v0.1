// ============================================================
// core/config/types.ts —— 全局配置领域类型（纯 TS，零平台依赖）
//
// 配置模式（与 opencode 不同）：**唯一配置文件** `.stem/stem.jsonc`
// （或 `.stem/stem.json`）是最终配置载体，全量存储所有可配置项；
// 本阶段不引入 `~/.config/stem/` 多级合并。
//
// **装载面二元制**：agent 类/上下文策略 = 目录即真相
//   （`.stem/agent/`、`.stem/context/` 自动装载，用户主权书写面）；
//   工具 = config.extensions.tools 点名（装载与出生一句话说完，
//   未点名 = 不存在于世界——代码注入面闭合）。
//   - **providers 注册表**（S6/R13）：模型端点全部 config 声明（`base_url` +
//     `key_env` 密钥注入 + `models` 白名单），代码零端点常量、零兜底；
//     模型引用一律 `提供商/模型`（如 `opencode-go/deepseek-v4-flash`）。
//   - **全量有效原则**（S6/R12）：config 即全部配置——未知顶层键 fail-fast，
//     `custom` 为唯一合法扩展位；顶层 model 链已拆除，家学锚点 = `user.model`。
// ============================================================

import type { ToolAccess } from '../tools'
import type { EffortLevel, ModelRef } from '../gateway'

/**
 * provider 注册表条目（S6/R13；块内 snake_case，对齐 OpenAI 生态书写习惯）。
 * OpenAI 兼容语义：POST `{base_url}/chat/completions`，请求 model 恒发裸 id。
 */
export interface StemProviderConfig {
  /** 端点基址（必填，如 `https://dashscope.aliyuncs.com/compatible-mode/v1`）。 */
  readonly base_url: string
  /** 密钥所在**环境变量名**（可缺省 = 匿名/本地端点；配置文件永不承载明文密钥）。 */
  readonly key_env?: string
  /** 启用模型白名单（空数组/缺省 = 全启用）。 */
  readonly models?: readonly string[]
}

/**
 * 根（user#0）的类配置（`config.user`——根实例出生即 user 类的普通实例）。
 * 与 AgentClass 形状同构（类名固定 'user' 不可配，防命名空间入侵）：
 * 根之"人格"（工具清单/提示词/倒计时/模型/策略/称呼）全部声明式可配，
 * 缺省走内置默认（USER_DEFAULT 见 kernel/builtin/agents）。
 */
export interface StemUserClass {
  readonly description?: string
  readonly systemPrompt?: string
  /**
   * 工具清单 = 收敛链第一环（键即白名单：未列出的工具对根一律 deny；
   * 对子孙则只供显式判定——缺席 ≠ 否决，显式 deny = 铁律锁子孙）；逐键被
   * 注册表出生值封顶（越界 = boot 硬错）。缺省 = 完整继承出生表面；
   * 推荐清单实值见首启模板（DEFAULT_CONFIG_TEXT）——模板不是机制。
   */
  readonly tools?: Readonly<Record<string, ToolAccess>>
  /** 上下文管理策略（根面板态默认不消费，pilot 未来 as() 扩展预留）。 */
  readonly contextStrategy?: string
  /**
   * **家学锚点**（S6/R12 必填，boot 硬校验）：全体 agent 模型解析链
   * （显式 > 类基因 > 父继承 > 家学）的链尾默认值。
   */
  readonly model?: ModelRef
  /** 送信倒计时毫秒（缺省 0 = 直接获得回复）。 */
  readonly sendCountdown?: number
  /** 采样温度家学缺省。 */
  readonly temperature?: number
  /** 思考强度家学缺省（缺省 none）。 */
  readonly effort?: EffortLevel
  /** 根的出生称呼（B2；缺省 'user' → 全名 user#0。实例参数不上类，运行期改名走 agent_update.name）。 */
  readonly name?: string
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

/** 工具框架配置块（`config.tools`；与 tools/output.ts 的窗口限制同源）。 */
export interface StemToolsConfig {
  /** 工具结果进入上下文的字符上限；0/未设 = 不启用（默认零行为变更）。 */
  readonly outputLimit?: number
}

/**
 * extensions 资源点名面：
 *   - tools = **{名: 权限词} 对象**（装载与出生一句话说完：键在
 *     `extension/tools/` 或 `.stem/tools/` 解析命中才装载；键不可解析 =
 *     boot 硬错。custom 目录自动扫描已废止——未点名 = 不存在于世界）；
 *   - agent / context = 点名条目名数组（`extension/<键>/` 目录形态）。
 */
export interface StemExtensionsConfig {
  readonly tools?: Readonly<Record<string, ToolAccess>>
  readonly agent?: readonly string[]
  readonly context?: readonly string[]
}

/** 全局配置（`.stem/stem.jsonc` 的内容形状）。 */
export interface StemConfig {
  /**
   * 模型提供商注册表（S6/R13，键 = provider 名）。引用格式 `提供商/模型`；
   * 一切模型引用（user.model/类文件/实例化参数）的 provider 必须在此注册。
   */
  readonly providers?: Readonly<Record<string, StemProviderConfig>>
  /** 是否开启权限自动批准（true 时 ask 直接放行，不弹窗）。 */
  readonly autoApprove?: boolean
  /** 根的类配置（族谱根 = 收敛链首层）。 */
  readonly user?: StemUserClass
  /** 上下文策略配置（window/compact）。 */
  readonly context?: StemContextConfig
  /** bash 工具配置（超时/输出上限/shell 路径/缺省目录）。 */
  readonly bash?: StemBashConfig
  /** 工具框架配置（结果窗口限制等）。 */
  readonly tools?: StemToolsConfig
  /** 全局默认送信倒计时（毫秒；agent 文件/类未指定时使用）。 */
  readonly sendCountdown?: number
  /**
   * 资源点名清单：tools = {名: 权限词}（装载与出生一句话说完，键不可解析 =
   * boot 硬错）；agent/context = `extension/<键>/` 下条目名数组。
   * 工具**未点名 = 不存在于世界**（custom 目录扫描已废止——`.stem/tools/` 放
   * 什么文件都不如本清单点名有权威，代码注入面闭合）。agent 类/策略仍是
   * `.stem/agent/`、`.stem/context/` 目录即真相（用户主权书写面不受影响）。
   * core 只透传语义化清单，装载由 init 管线执行（extension 根路径由宿主注入）。
   */
  readonly extensions?: StemExtensionsConfig
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
