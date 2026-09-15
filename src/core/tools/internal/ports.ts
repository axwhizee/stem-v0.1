// ============================================================
// core/tools/internal/ports.ts —— 端口倒置（DIP）：internal 工具对宿主能力的窄端口
//
// 消费方（tools）拥有接口，实现方（kernel）经适配器兑现，组合根接线。
// **中性 DTO**：本文件不得 import kernel——kernel 的领域类型在此以中性形状
// 重新表达，适配器负责字段搬运。由此消除 tools → kernel 的源码依赖。
//
// 按域拆分（禁止 God interface）：
//   AgentPort   —— 族谱/实例/类/寻址/通信（agent_*、mail_*）
//   ContextPort —— 上下文本体操作（context_*、agent_pause）
//   TelemetryPort —— 日志读取（telemetry_query）
//   AccessPort  —— ask 审批回复（access_reply）
// ============================================================

import type { ModelRef } from '../../gateway'
import type { LogEvent } from '../../logging'
import type { AccessReplyInput, ToolAccess } from '../types'

// ---------- 中性 DTO ----------

/** 类模板视图（agent_class_list / agent_class_update 读取面；与 AgentClassGenes 对齐）。 */
export interface AgentClassView {
  readonly name: string
  readonly description: string
  readonly tools?: Readonly<Record<string, ToolAccess>>
  readonly contextStrategy?: string
  readonly model?: ModelRef
  readonly sendCountdown?: number
  readonly temperature?: number
  readonly effort?: 'none' | 'low' | 'medium' | 'high'
}

/** 类创建入参（agent_class_create）。 */
export interface AgentClassInput {
  readonly name: string
  readonly description: string
  readonly systemPrompt: string
  readonly tools?: Readonly<Record<string, ToolAccess>>
  readonly contextStrategy?: string
  readonly model?: ModelRef
  readonly sendCountdown?: number
  readonly temperature?: number
  readonly effort?: 'none' | 'low' | 'medium' | 'high'
}

/** 类更新 patch（agent_class_update；只做增量合并）。 */
export interface AgentClassPatchInput {
  readonly description?: string
  readonly systemPrompt?: string
  readonly tools?: Readonly<Record<string, ToolAccess>>
  readonly contextStrategy?: string
  readonly model?: ModelRef
  readonly sendCountdown?: number
  readonly temperature?: number
  readonly effort?: 'none' | 'low' | 'medium' | 'high'
}

/** 实例视图（agent_list / agent_inspect 读取面）。 */
export interface AgentInstanceView {
  readonly id: string
  readonly name: string
  readonly classRef: string
  readonly parentId: string | null
  readonly status: string
  readonly turnCount: number
  readonly totalCost: number
  /** 终身累计 token（usage in+out 累加，不受 compact 影响）。 */
  readonly totalTokens: number
}

/** 实例化请求（agent_instantiate；accessMode 恒为普通收敛，grant 属策略/宿主专用）。 */
export interface InstantiateRequest {
  readonly className: string
  readonly userPrompt: string
  readonly parentId: string | null
  readonly name?: string
  readonly model?: ModelRef
  readonly contextRefs?: readonly string[]
  readonly tools?: Readonly<Record<string, ToolAccess>>
  /** wait 配对（hold 随实例化原子注册）；toolCallId = 本次调用 id。 */
  readonly hold?: { readonly toolCallId: string; readonly timeoutMs?: number }
}

/** 实例参数更新请求（agent_update；可写面 = name/model/temperature/effort）。 */
export interface AgentUpdateRequest {
  readonly agentId: string
  /** 发起者（可见域校验）；缺省 = 信任通道（跳过判定）。 */
  readonly by?: string
  readonly name?: string
  readonly model?: ModelRef
  readonly temperature?: number
  readonly effort?: 'none' | 'low' | 'medium' | 'high'
}

/** 生效配置视图（agent_inspect：模型四级律 + 权限物化面）。 */
export interface AgentConfigView {
  readonly model?: { readonly provider: string; readonly id: string; readonly origin: string }
  readonly access?: {
    readonly explicit: Readonly<Record<string, ToolAccess>>
    readonly fallback?: ToolAccess
  }
}

/** 上下文消息视图（context_* 读取面）。 */
export interface StoredMessageView {
  readonly id: string
  readonly turn: number
  readonly role: string
}

// ---------- 按域窄端口 ----------

/** 族谱/实例/类/寻址/通信域。 */
export interface AgentPort {
  /** 三形态寻址（name / name#id / 裸 id 前缀）；失败抛带 candidates 的判别联合错误。 */
  readonly resolveAgent: (ref: string) => string
  /** 全名呈现 `name#id`。 */
  readonly displayOf: (agentId: string) => string
  /** 树谓词：by 可见域是否覆盖 target（自身 ∨ 祖先）。 */
  readonly canReach: (by: string, target: string) => boolean
  /** 邮局在册参与者全名列表。 */
  readonly listParticipants: () => Promise<readonly string[]>
  /** 以 from 身份投递信件给 to。 */
  readonly sendMessage: (from: string, to: string, payload: string) => Promise<void>

  readonly listClasses: () => Promise<readonly AgentClassView[]>
  /** 同步取类（缺省目标类推断用）。 */
  readonly getClassSync: (name: string) => AgentClassView | undefined
  readonly registerAgentClass: (
    cls: AgentClassInput,
    opts?: { readonly persist?: boolean; readonly by?: string },
  ) => Promise<{ readonly persisted: boolean }>
  readonly updateAgentClass: (
    name: string,
    patch: AgentClassPatchInput,
    opts?: { readonly persist?: boolean; readonly by?: string },
  ) => Promise<{ readonly persisted: boolean }>
  readonly hasClassStore: () => boolean

  readonly instantiate: (req: InstantiateRequest) => Promise<string>
  readonly updateAgent: (req: AgentUpdateRequest) => Promise<void>
  readonly terminateAgent: (agentId: string, opts?: { readonly by?: string; readonly recursive?: boolean }) => Promise<void>

  readonly listInstances: () => Promise<readonly AgentInstanceView[]>
  readonly getInstance: (agentId: string) => Promise<AgentInstanceView>
  readonly getInstanceSync: (agentId: string) => AgentInstanceView | undefined
  readonly getChildren: (agentId: string) => readonly string[]
  readonly getAncestors: (agentId: string) => readonly string[]
  readonly getDescendants: (agentId: string) => readonly string[]
  /** 生效配置（模型绑定 + 权限台账）；未绑定 = undefined。 */
  readonly getAgentConfig: (agentId: string) => AgentConfigView | undefined
}

/** 上下文本体域。 */
export interface ContextPort {
  readonly registerPause: (agentId: string, opts: { readonly toolCallId: string; readonly ms: number }) => Promise<void>
  readonly getState: (agentId: string) => Promise<{ readonly messages: readonly StoredMessageView[] }>
  readonly runStrategyAction: (agentId: string, action: string, args: string) => Promise<string>
  readonly markInvalid: (agentId: string, ids: readonly string[]) => Promise<void>
  /** 重写消息正文（保留 role/索引）。 */
  readonly updateMessageContent: (agentId: string, messageId: string, content: string) => Promise<void>
  readonly exportJsonl: (agentId: string) => Promise<string>
  readonly overview: (agentId: string) => Promise<string>
}

/** 日志读取域。 */
export interface TelemetryPort {
  readonly allLogs: () => readonly LogEvent[]
}

/** ask 审批回复域。 */
export interface AccessPort {
  readonly reply: (input: AccessReplyInput, agentId: string) => Promise<void>
}

/**
 * internal 工具的宿主能力总口（tools 私有；仅 kernel 适配器实现、组合根注入）。
 * 其他模块不得 import 本类型。
 */
export interface SystemToolHost {
  readonly agents: AgentPort
  readonly context: ContextPort
  readonly telemetry: TelemetryPort
  readonly access: AccessPort
}
