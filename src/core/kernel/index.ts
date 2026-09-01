// ============================================================
// core/kernel/index.ts —— 唯一出口（只 re-export）
// ============================================================

// 类型
export type {
  AgentClassID,
  AgentID,
  AgentSpaceID,
  ProjectRef,
  AgentStatus,
  AgentClass,
  AgentInstance,
  AgentInstancePatch,
  AgentSpace,
  KernelError,
} from './types'
export { makeAgentClassID, makeAgentID, makeAgentSpaceID } from './types'

// 模板注册表
export type { TemplateRegistry } from './TemplateRegistry'
export { DefaultTemplateRegistry } from './TemplateRegistry'

// 实例管理
export type { InstantiateOptions, InstanceManager } from './InstanceManager'
export { DefaultInstanceManager } from './InstanceManager'
export type { InstanceStore } from './store'
export { MemoryInstanceStore } from './store'
export { PersistedInstanceManager, PersistedSpaceManager } from './persisted'

// 空间管理
export type { SpaceManager } from './SpaceManager'
export { DefaultSpaceManager } from './SpaceManager'
// 运行时
export type { RuntimeDeps, Runtime } from './Runtime'
export { DefaultRuntime } from './Runtime'

// Kernel 容器
export type { KernelOptions, ClassStore } from './Kernel'
export { Kernel, BUILTIN_TEMPLATES, USER_ID } from './Kernel'

// 内置 user 类（根模板，user0 采用）
export { USER_CLASS_ID, createUserClass } from './userClass'

// 系统管理工具
export { createSystemTools } from './systemTools'
