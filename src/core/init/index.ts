// ============================================================
// core/init/index.ts —— 唯一出口（只 re-export）
// ============================================================

export type { InitDeps, InitFs, InitToolLoader, InitIssue, InitReport, InitError, ClassFs, ResourceEntry, DiscoveredEntry } from './types'
export { runInit } from './init'
export { parseAgentFile, parseFrontmatter, extractPrompt } from './agentParse'
export type { AgentFrontmatter, ParsedAgentFile } from './agentParse'
// 类序列化（S5.2 进化书写面：agentParse 的逆 + 落盘路径守卫）
export { serializeAgentClass, agentFileName, agentFileOf, AGENT_KNOWN_KEYS } from './agentSerialize'

// 系统初始化与装配（组合根）
export type { StemSystem, UserInitHook, StemSystemDeps } from './system'
export { createStemSystem } from './system'
