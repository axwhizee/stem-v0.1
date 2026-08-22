// ============================================================
// core/init/index.ts —— 唯一出口（只 re-export）
// ============================================================

export type { InitDeps, InitFs, InitToolLoader, InitIssue, InitReport, InitError } from './types'
export { runInit } from './init'
export { parseAgentFile, parseFrontmatter, extractPrompt } from './agentParse'
export type { AgentFrontmatter, ParsedAgentFile } from './agentParse'

// 系统初始化与装配（组合根）
export type { StemSystem, UserInitHook, StemSystemDeps } from './system'
export { createStemSystem } from './system'
