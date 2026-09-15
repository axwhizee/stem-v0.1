// ============================================================
// core/kernel/index.ts —— 唯一出口（只 re-export）
// ============================================================

// 类型
export type {
  AgentClassID,
  AgentID,
  ProjectRef,
  AgentStatus,
  AgentClass,
  AgentInstance,
  AgentInstancePatch,
  KernelError,
  ModelBinding,
  ModelOrigin,
} from './types'
export { makeAgentClassID, makeAgentID } from './types'

// 模板注册表
export type { TemplateRegistry } from './TemplateRegistry'
export { DefaultTemplateRegistry } from './TemplateRegistry'

// 实例管理
export type { InstantiateOptions, InstanceManager, ResolveResult } from './InstanceManager'
export { DefaultInstanceManager } from './InstanceManager'
export type { InstanceStore } from './store'
export { PersistedInstanceManager } from './persisted'

// 运行时端口（调用方拥有；实现住 main/runtime.ts，组合根注入）
export type { RuntimePort, RuntimePortDeps } from './runtimePort'

// 系统门面（pilot 消费面；实现住 main/systemFacade.ts，组合根注入）
export type { SystemFacade } from './systemFacade'

// Kernel 容器
export type { KernelOptions, ClassStore } from './Kernel'
export { Kernel, BUILTIN_TEMPLATES } from './Kernel'

// 身份常量与全名呈现（根 id `0` / 缺省称呼 user / `name#id`）
export { USER_CLASS_ID, ROOT_ID, ROOT_NAME, formatFull, parentIdOf, AGENT_ID_PATTERN } from './types'

// 类字段单一真相（校验 + 键名映射 + 归一）
export {
  AGENT_KNOWN_KEYS,
  asModelRef,
  asNonNegNumber,
  asString,
  asToolAccessRecord,
  normalizeAgentFields,
  parseModelRefString,
  pickAgentClassGenes,
  frontmatterKeyOf,
} from './attributes'
export type { AgentClassGenes, NormalizeMode, NormalizeOptions } from './attributes'

// 内置 user 类（根模板）
export { BUILTIN_AGENT_CLASSES, USER_DEFAULT, ASSISTANT, buildUserClass } from './builtin/agents'
export type { UserClassConfig } from './builtin/agents'

// 系统工具宿主适配器（internal 工具端口实现；组合根接线用）
export { createSystemToolHost } from './toolHost'
