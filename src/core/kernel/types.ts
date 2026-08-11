// ============================================================
// core/kernel/types.ts —— Agent Kernel 领域类型（纯 TS，零平台依赖）
//
// branded id / AgentClass（模板）/ AgentInstance（实例）/
// AgentSpace / PermissionLevel / 错误判别联合。
// ============================================================

import type { ChatMessage, ModelRef } from '../gateway'

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

export function makeAgentID(id: string): AgentID {
  return id as AgentID
}

export function makeAgentSpaceID(id: string): AgentSpaceID {
  return id as AgentSpaceID
}

// ---------- 权限与状态 ----------

/** 权限分级：normal=业务/对话；advanced=实例创建/调度；admin=类创建/模块改造/全量日志。 */
export type PermissionLevel = 'normal' | 'advanced' | 'admin'

/** 实例状态（对齐 UI 展示）。 */
export type AgentStatus = 'idle' | 'running' | 'waiting'

/** 工具引用（声明在模板上，执行器后续由 ToolCapabilityRegistry 提供）。 */
export interface ToolRef {
  readonly id: string
  readonly permission?: PermissionLevel
}

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

export interface AgentClass {
  readonly id: AgentClassID
  /** 展示名，如 "Coder" / "Reviewer"。 */
  readonly name: string
  readonly description: string
  /** 该类的专属系统提示词。 */
  readonly systemPrompt: string
  /** 上下文组装策略（可继承/定制）。 */
  readonly contextProfile?: ContextProfile
  /** 该类实例可用的工具。 */
  readonly tools: readonly ToolRef[]
  readonly permission: PermissionLevel
  /** 可访问的上下文资产标签（ContextAssetPool 接入后启用）。 */
  readonly memoryScope: readonly string[]
  /** 可选模型偏好。 */
  readonly model?: ModelRef
  /** 用户自定义元数据。 */
  readonly custom?: Readonly<Record<string, unknown>>
}

// ---------- AgentInstance（运行时原子单位） ----------

export interface AgentInstance {
  readonly id: AgentID
  readonly classRef: AgentClassID
  /** 用户可命名（可接管改名）。 */
  displayName: string
  /** 区分用户创建 vs 调度创建。 */
  readonly createdBy: 'user' | AgentID
  readonly spaceId: AgentSpaceID
  status: AgentStatus
  turnCount: number
  totalCost: number
  /** 对话历史（context 最小实现；ContextHandle/资产池后续接入）。 */
  readonly history: ChatMessage[]
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
