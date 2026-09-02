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
//   - **providers 注册表**（S6/R13）：模型端点全部 config 声明（`base_url` +
//     `key_env` 密钥注入 + `models` 白名单），代码零端点常量、零兜底；
//     模型引用一律 `提供商/模型`（如 `opencode-go/deepseek-v4-flash`）。
//   - **全量有效原则**（S6/R12）：config 即全部配置——未知顶层键 fail-fast，
//     `custom` 为唯一合法扩展位；顶层 model 链已拆除，家学锚点 = `user.model`。
// ============================================================

import type { ToolAccess } from '../tools'
import type { ModelRef } from '../gateway'

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
  /**
   * **家学锚点**（S6/R12 必填，boot 硬校验）：全体 agent 模型解析链
   * （显式 > 类基因 > 父继承 > 家学）的链尾默认值。
   */
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
 * extensions 分键清单（S7 三维资源矩阵）：键 = extension 资源目录名，
 * 值 = 该目录下启用的条目名（目录形态资源，入口与目录同名）。
 */
export interface StemExtensionsConfig {
  readonly tools?: readonly string[]
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
   * 三维资源矩阵点名清单（S7）：按资源目录分键，值 = `extension/<键>/` 下
   * 要启用的条目名数组（目录形态资源，入口与目录同名）。
   * `tools` 缺省 = fs 五件套；`agent`/`context` 缺省 = 不启用；显式 `[]` = 纯 bash 最小系统。
   * 用户空间 `.stem/` 各目录自动扫描装载，不经本清单（目录即真相）。
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
