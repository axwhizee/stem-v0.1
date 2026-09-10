// ============================================================
// core/main/index.ts —— 唯一出口（只 re-export）
//
// 组合根模块：进程生命周期 + 装载管线 + agent 执行器。core 中唯一 import 一切的模块。
// ============================================================

export type { InitDeps, InitFs, InitToolLoader, InitIssue, InitReport, InitError, ClassFs, ResourceEntry, DiscoveredEntry } from './types'
export { runInit } from './loader'

// 系统初始化与装配（组合根）
export type { StemSystem, UserInitHook, StemSystemDeps } from './system'
export { createStemSystem } from './system'

// agent 执行器（原 kernel/Runtime.ts；Kernel 经 RuntimePort 接口消费）
export { DefaultRuntime, createRuntime } from './runtime'
export type { RuntimePort, RuntimePortDeps } from '../kernel'
