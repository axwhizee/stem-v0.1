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
import type { ToolAccess } from '../../tools'
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

/** 策略 agent 模板规格（role/worker 共用；kernel 首用即注册为内置模板）。 */
export interface StrategyAgentSpec {
  /** 模板名（首次使用时 ensure 进 TemplateRegistry）。 */
  readonly className: string
  readonly description: string
  readonly systemPrompt: string
  /** grant 加法权限面（整表替换 + 未列一律 deny；缺省 {} = 零工具）。 */
  readonly tools?: Readonly<Record<string, ToolAccess>>
  readonly model?: ModelRef
  readonly sendCountdown?: number
  /** true = 模块扮演面板（不跑 LLM 轮，只收信——宿主/收集器）。 */
  readonly panel?: boolean
  /** worker 的上下文策略（缺省 'none'：工具 agent 不再触发策略处理，断递归）。 */
  readonly contextStrategy?: string
}

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
  /** 日志出口（策略级事件：context.compacted 等）。 */
  readonly log: (event: { type: 'context.compacted'; agentId: string; outcome: 'compacted' | 'skipped' | 'failed'; compactedCount: number; message: string }) => void
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
}
