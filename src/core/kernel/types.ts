// ============================================================
// core/kernel/types.ts —— Agent Kernel 领域类型（纯 TS，零平台依赖）
//
// branded id / AgentClass（模板）/ AgentInstance（实例）/
// AgentSpace / 错误判别联合。
// ============================================================

import type { ModelRef } from '../gateway'
import type { ToolAccess } from '../tools'

// ---------- branded id ----------

declare const agentClassId: unique symbol
export type AgentClassID = string & { readonly [agentClassId]: 'AgentClassID' }

declare const agentId: unique symbol
export type AgentID = string & { readonly [agentId]: 'AgentID' }

declare const agentSpaceId: unique symbol
export type AgentSpaceID = string & { readonly [agentSpaceId]: 'AgentSpaceID' }

/** 项目/工作区引用（本阶段用字符串路径，后续可升级为 WorkspaceRef）。 */
export type ProjectRef = string

export function makeAgentClassID(id: string): AgentClassID {
  return id as AgentClassID
}

/** 元 agent 类（user0 专用，注册表不承载，代码级常量）。 */
export const META_CLASS_ID: AgentClassID = '__meta__' as AgentClassID

export function makeAgentID(id: string): AgentID {
  return id as AgentID
}

export function makeAgentSpaceID(id: string): AgentSpaceID {
  return id as AgentSpaceID
}

// ---------- 状态 ----------

/**
 * 实例状态机：
 *   idle →(邮局送信)→ thinking(请求已发) →(LLM 返回)→ holding(等待下一次送信)；
 *   interrupted：当前轮被中断（用户/进程/网络/工具错误），实例仍存活、消息完整，下一次送信自动恢复。
 */
export type AgentStatus = 'idle' | 'thinking' | 'holding' | 'interrupted'

// ---------- 上下文策略（最小占位） ----------

/**
 * 上下文组装策略。当前仅支撑：systemPrompt 覆盖 / 是否携带历史。
 * renderPrompt + tokenizer 预算（modelMaxPromptTokens）延后接入。
 */
export interface ContextProfile {
  readonly systemPrompt?: string
  readonly includeHistory?: boolean
  readonly modelMaxPromptTokens?: number
}

// ---------- AgentClass（模板，用户主权的载体） ----------

/**
 * AgentClass（模板）。**name 即 id**（注册时查重），无单独 id 字段。
 * 工具清单 `tools` 融合白名单与访问：`Record<访问键, ask|deny|allow|ignore>`，
 * **键即白名单**（未列出的工具不可用），值对全局表做收敛补充（只能更严格）。
 * `contextStrategy` 为实例上下文管理策略（默认 classic），在开辟上下文空间时写入。
 */
export interface AgentClass {
  /** 类名，唯一（注册时查重；即模板键）。 */
  readonly name: AgentClassID
  readonly description: string
  /** 该类实例可用的工具清单（融合白名单+访问）：Record<访问键, ask|deny|allow|ignore>。 */
  readonly tools: Readonly<Record<string, ToolAccess>>
  /** 该类的专属系统提示词（模板承载，实例化注册到邮局）。 */
  readonly systemPrompt: string
  /** 上下文管理策略（默认 classic；实例化时写入上下文属性）。 */
  readonly contextStrategy?: string
  /** 可选模型偏好。 */
  readonly model?: ModelRef
  /** 送信倒计时（毫秒，默认 1000）；实例化时传给邮局。 */
  readonly sendCountdown?: number
  /** 用户自定义元数据。 */
  readonly custom?: Readonly<Record<string, unknown>>
}

// ---------- AgentInstance（运行时原子单位） ----------

/**
 * AgentInstance（运行时原子单位）。
 * **parentId 即 creatorId 合并**：谁创建实例，谁就是族谱父（user0 为 null 即根）。
 * 运行时属性多于工具调用参数（status/turnCount/totalCost 等由内核维护）。
 */
export interface AgentInstance {
  readonly id: AgentID
  /** 模板名（即模板键）。 */
  readonly classRef: AgentClassID
  /** 族谱父（= 创建者；user0 为 null 即根）；创建时确定、不可变。 */
  readonly parentId: AgentID | null
  /** 用户可命名（可接管改名）。 */
  displayName: string
  readonly spaceId: AgentSpaceID
  status: AgentStatus
  turnCount: number
  totalCost: number
  /** 实例化时必填的 user prompt（作为首封信投递，符合 openai messages 规范）。 */
  readonly userPrompt: string
  /** 实例化时传入的工具清单补充（对模板表的收敛，可临时收紧；运行时仅用于组装）。 */
  readonly toolOverride?: Readonly<Record<string, ToolAccess>>
}

/** 用户接管/微调可更新的字段。 */
export type AgentInstancePatch = Pick<AgentInstance, 'displayName'>

// ---------- AgentSpace（项目级 agent 空间，最小） ----------

export interface AgentSpace {
  readonly id: AgentSpaceID
  readonly project: ProjectRef
}

// ---------- 错误（判别联合，code-style §4.1） ----------

export type KernelError =
  | { readonly kind: 'template_not_found'; readonly classId: AgentClassID }
  | { readonly kind: 'invalid_template'; readonly classId: AgentClassID; readonly message: string }
  | { readonly kind: 'template_exists'; readonly classId: AgentClassID }
  | { readonly kind: 'agent_not_found'; readonly agentId: AgentID }
  | { readonly kind: 'space_not_found'; readonly spaceId: AgentSpaceID }
  | { readonly kind: 'agent_conflict'; readonly message: string }
