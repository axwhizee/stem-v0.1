// ============================================================
// core/kernel/index.ts —— 唯一出口（只 re-export）
// ============================================================

// 类型
export type {
  AgentClassID,
  AgentID,
  AgentSpaceID,
  ProjectRef,
  PermissionLevel,
  AgentStatus,
  ToolRef,
  ContextProfile,
  AgentClass,
  AgentInstance,
  AgentInstancePatch,
  AgentSpace,
  KernelError,
} from './types'
export { makeAgentClassID, makeAgentID, makeAgentSpaceID } from './types'

// 模板注册表
export type { TemplateListFilter, AgentTemplateRegistry } from './AgentTemplateRegistry'
export { DefaultAgentTemplateRegistry } from './AgentTemplateRegistry'

// 实例管理
export type { InstantiateOptions, AgentInstanceManager } from './AgentInstanceManager'
export { DefaultAgentInstanceManager } from './AgentInstanceManager'

// 空间管理
export type { AgentSpaceManager } from './AgentSpaceManager'
export { DefaultAgentSpaceManager } from './AgentSpaceManager'

// 运行时
export type { AgentRuntimeDeps, AgentRuntime } from './AgentRuntime'
export { DefaultAgentRuntime } from './AgentRuntime'

// Kernel 容器
export type { AgentKernelOptions } from './AgentKernel'
export { AgentKernel, BUILTIN_TEMPLATES, USER_ID } from './AgentKernel'

// 系统管理工具
export { createSystemTools } from './systemTools'
