// ============================================================
// core/context/strategies/types.ts —— 上下文策略模块契约（独立模块 = 独立接口）
//
// 设计（prompts §11 共识落地）：
//   - 每种上下文管理策略 = context/strategies/ 下的独立模块，实现
//     ContextStrategyModule；触发点 = user_prompt 信件抵达，
//     处理终点 = 完整上下文就绪（提醒快递员）；
//   - 两段式生命周期：process（允许异步——可做摘要/整理等任意工作，
//     含经系统通道创建工具 agent）与 assemble（纯函数同步——送信快照组装）
//     分离，快递员永不异步；
//   - 策略可导出专有动作（actions，如 classic 的 compact），
//     经 pilot / context_apply 工具调用——策略即 agent 自我进化的
//     两大承载之一（另一为 agent 类模板）；
//   - 策略需要"人设"时用**模块扮演 agent**（role）：懒生成的系统实例
//     （父 = 宿主 agent，面板态不跑 LLM 轮），pilot 扮演 user0 的同构推广；
//   - 策略模块跑在系统信任级（与 pilot 同级，非沙箱模型）：
//     StrategyApi 授予仓库读写 + 邮局投递 + 造 agent（grant 加法权限面）能力。
//
// core 零平台依赖：本契约纯 TS；worker 的创建/回收由 kernel 经注入回调执行。
// ============================================================

import type { ChatMessage, ModelRef } from '../../gateway'
import type { ToolCapability } from '../../tools'
import type { AgentClass } from '../../kernel/types'
import type { LogSink } from '../../logging'
import type { ContextCompacted, ContextDreamed } from '../../logging/events'
import type { AssembleInput, AssembleResult, StoredMessage } from '../types'

/** 上下文策略配置（缺省在此；S3 起可被 config.context 覆盖）。 */
export interface ContextSettings {
  /** prompt 预算（估算 token；估算口径 = 字符/4，与仓库同源）。 */
  readonly window: number
  readonly compact: {
    readonly enabled: boolean
    /** 触发阈值（估算 token 占 window 比例）。 */
    readonly threshold: number
    /** 保留最近轮数（轮 = 一条 user 消息 + 其引发的工具调用）。 */
    readonly keepRecentTurns: number
    /** 摘要 worker 指令（缺省用 classic 模块内置模板）。 */
    readonly instruction?: string
    /** 摘要 worker 模型（S6/R6 类基因位；缺省 = 走出生链继承宿主档案）。 */
    readonly summarizeModel?: ModelRef
    /** 等待 worker 回信超时（毫秒；超时本轮放弃压缩，不卡送信）。 */
    readonly replyTimeoutMs: number
  }
}

export const DEFAULT_CONTEXT_SETTINGS: ContextSettings = {
  window: 128_000,
  compact: { enabled: true, threshold: 0.8, keepRecentTurns: 3, replyTimeoutMs: 60_000 },
}

/**
 * 策略 agent 模板规格 = **AgentClass 本尊**（S9 类形态统一：role/worker 与
 * 用户类同形状，契约字段语义 = AgentClass 各字段；kernel 首用即 ensure 注册）。
 * 要点：role 面板的 `tools` 若"不设" = 匿名不封顶（worker grant 通道需要）；
 * 显式空表 = 本地封闭并锁子孙。
 */
export type StrategyAgentSpec = AgentClass

/** 策略运行时 API（管理员按宿主 agent 构造注入）。 */
export interface StrategyApi {
  readonly agentId: string
  readonly settings: ContextSettings
  /** 有效消息估算 token 合计（与仓库 estimateTokens 同源）。 */
  readonly estimatedTokens: () => number
  readonly list: () => readonly StoredMessage[]
  readonly listValid: () => readonly StoredMessage[]
  /** 合成消息经邮局正规追加（write-through 自动落库；tag 标记非原生）。 */
  readonly append: (message: ChatMessage, tag?: string) => Promise<void>
  /** 标记消息无效（仓库保留语料，组装跳过——压缩可逆可审计）。 */
  readonly markInvalid: (ids: readonly string[]) => Promise<void>
  /**
   * 在本策略的扮演 agent（role，懒生成）名下创建工具 agent 执行任务，
   * 等待其最终回信（标准邮局往返；worker 完成后自动归档回收）。
   */
  readonly spawn: (task: string, spec: StrategyAgentSpec) => Promise<string>
  /** 本箱最近一次 spawn 的 worker 实例 id（策略机制工具的身份解析通道；未 spawn 过 = undefined）。 */
  readonly lastWorkerId?: () => string | undefined
  /** 本箱策略扮演 agent id（role 懒生成后才有值）。 */
  readonly roleAgentId?: () => string | undefined
  /**
   * 行内改写单行内容（合成行的再生通道——目录轮转等纯内容更新用，
   * 不新增行不破坏配对结构；涉及结构合法性时由策略自行保证）。
   */
  readonly updateMessage?: (id: string, message: ChatMessage) => Promise<void>
  /** 宿主 agent 类模板的 custom 自由槽（策略基因参数载体，如 cortex 的 dreamAt）。 */
  readonly custom?: Readonly<Record<string, unknown>>
  /** 日志出口（策略级事件；at 由管理员注入）。 */
  readonly log: (event: StrategyLogEvent) => void
}

/** 策略可上报的日志事件（LogEvent 中去掉管理员补的 at）。 */
export type StrategyLogEvent = Omit<ContextCompacted, 'at'> | Omit<ContextDreamed, 'at'>

/** 策略 init 期的文件系统能力（宿主注入的窄口；写面缺省 = 空间只读，策略须降级）。 */
export interface StrategyInitFs {
  readonly listFiles: (dir: string) => Promise<readonly string[]>
  readonly readText: (file: string) => Promise<string>
  readonly writeText?: (file: string, content: string) => Promise<void>
  readonly ensureDir?: (dir: string) => Promise<void>
}

/**
 * 策略装载期上下文（组合根注入；先于工具 initAll 执行——
 * registerTool 注册的工具可参与 init 生命周期）。
 */
export interface StrategyInitContext {
  /** 当前空间根（`.stem/` 所在目录；策略数据目录据此定位）。 */
  readonly projectRoot: string
  readonly fs: StrategyInitFs
  /** 全局上下文配置（window 等——类级 custom 参数经 StrategyApi.custom 逐宿主给）。 */
  readonly settings: ContextSettings
  readonly log: LogSink
  /** 注册策略自带工具（kind='custom'，同策略信任级；同名覆盖幂等）。 */
  readonly registerTool: (tool: ToolCapability) => Promise<void>
}

/** 上下文策略模块（独立子模块的统一形状；assemble 必须，其余按策略能力）。 */
export interface ContextStrategyModule {
  /** 策略名（AgentClass.contextStrategy 引用；注册表唯一）。 */
  readonly name: string
  /** 策略说明：注册时追加到宿主 systemPrompt（模型知晓自身记忆机制）。 */
  readonly note?: string
  /** 扮演 agent 规格（需要造 worker 的策略声明；懒生成，父 = 宿主）。 */
  readonly role?: StrategyAgentSpec
  /** 纯组装（同步；送信快照）。 */
  readonly assemble: (input: AssembleInput) => AssembleResult
  /**
   * user_prompt 信件抵达钩子：返回即「完整上下文就绪」（随后提醒快递员）。
   * 允许异步（含 spawn）；失败由管理员兜底——绝不卡死送信链路。
   */
  readonly process?: (api: StrategyApi) => Promise<void>
  /** 策略专有动作（pilot / context_apply 工具 / CLI 通道调用）。 */
  readonly actions?: Record<string, (api: StrategyApi, args: string) => Promise<string>>
  /**
   * 装载期初始化（可选；组合根在工具 initAll 之前逐策略调用一次）：
   * 建数据目录、registerTool 注册策略自带工具、全局参数校验等。
   */
  readonly init?: (ctx: StrategyInitContext) => Promise<void>
}
