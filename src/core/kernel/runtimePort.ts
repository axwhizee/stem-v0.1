// ============================================================
// core/kernel/runtimePort.ts —— agent 执行器端口（调用方拥有，D3 端口倒置）
//
// Kernel 只认本接口（启动/中断/收尾/送信驱动），实现住 main/runtime.ts，
// 由组合根经 KernelOptions.runtime 工厂注入。由此消除 kernel → 具体执行器的
// 反向依赖，kernel 不再 import main。
// ============================================================

import type { LLMEvent, ModelGateway, ModelRef, UsageEvent } from '../gateway'
import type { LogSink } from '../logging'
import type { AgentDelivery, ContextManager, Repository } from '../context'
import type { ToolCapabilityRegistry } from '../tools'
import type { InstanceManager } from './InstanceManager'
import type { AgentClass, AgentClassID, AgentID, AgentStatus } from './types'

/** 执行器装配依赖（由 kernel 组合、实现方消费）。 */
export interface RuntimePortDeps {
  readonly gateway: ModelGateway
  readonly instances: InstanceManager
  readonly contextManager: ContextManager
  /** 上下文仓库（assistant/tool 消息入库）。 */
  readonly repository: Repository
  /** 工具注册表（缺省不启用工具轮）。 */
  readonly tools?: ToolCapabilityRegistry
  /**
   * 模型解析端口（父子继承链——显式 > 类基因 > 父继承；
   * kernel 接 lineage.modelOf。undefined = 全链无锚，见 processDelivery 防御）。
   */
  readonly resolveModel: (agentId: AgentID) => ModelRef | undefined
  /** 全局最大循环步数兜底（含工具轮；**≤0/未设 = 无限制**）。 */
  readonly maxSteps?: number
  /** 工具输出进入会话的字符上限（config.tools.outputLimit；0/未设 = 不启用）。 */
  readonly toolOutputLimit?: number
  /** 类模板读取口（类基因 maxSteps 每轮起点解析；缺省只看全局兜底）。 */
  readonly templates?: { getSync: (name: AgentClassID) => AgentClass | undefined }
  readonly estimateCost?: (usage: UsageEvent | undefined) => number
  /** 流式事件全局透传（shell 面板显示用）。 */
  readonly onEvent?: (agentId: AgentID, event: LLMEvent) => void
  /** 状态变化通知（agentId, from, to）。 */
  readonly onStatus?: (agentId: AgentID, from: AgentStatus, to: AgentStatus) => void
  /** 日志出口（组合根注入 → core/logging）。 */
  readonly onLog?: LogSink
  /** 可注入计时器（drain 超时兜底；缺省 setTimeout，与 Courier/管理员同法）。 */
  readonly timer?: (fn: () => void, ms: number) => { cancel: () => void }
  /** 项目根（单空间；ToolContext.spaceId = 项目路径）。 */
  readonly projectRoot?: string
}

/** agent 执行器端口（kernel 消费面）。 */
export interface RuntimePort {
  /** 邮局送信回调（kernel 装配时注册）。 */
  readonly processDelivery: (delivery: AgentDelivery) => Promise<void>
  /** 邮局倒计时结束无信 → hold。 */
  readonly notifyHold: (agentId: AgentID) => Promise<void>
  /** 中断指定 agent 的当前轮（触发 AbortController.abort）。 */
  readonly abort: (agentId: AgentID) => void
  /** 中断所有活跃 agent（进程优雅收尾用）。 */
  readonly abortAll: () => void
  /** 当前活跃（thinking/进行中）的 agent id 列表。 */
  readonly activeAgents: () => readonly AgentID[]
  /** 等活跃轮收尾落账（abort 之后调用；超时兜底，dispose 前必须 drain）。 */
  readonly drainActiveTurns: (timeoutMs?: number) => Promise<void>
}
