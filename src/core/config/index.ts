// ============================================================
// core/config/index.ts —— 唯一出口（只 re-export）
// ============================================================

export type { RegisteredTool, RegisteredAgent, StemConfig, ConfigLoadResult, ConfigError } from './types'
export { parseConfigText, normalizeConfig, parseModelRef } from './parse'
export type { ConfigStore, ConfigPaths } from './store'
