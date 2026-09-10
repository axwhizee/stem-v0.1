// ============================================================
// core/config/index.ts —— 唯一出口（只 re-export，不写逻辑）
// ============================================================

export type {
  StemConfig,
  StemProviderConfig,
  StemUserClass,
  StemContextConfig,
  StemBashConfig,
  StemToolsConfig,
  ConfigLoadResult,
  ConfigError,
} from './types'
export { parseConfigText, normalizeConfig } from './parse'
export { DEFAULT_CONFIG_TEXT, defaultStemConfig } from './defaults'
export type { ConfigStore, ConfigPaths } from './store'

// `.stem/agent/<name>.md` 用户文件契约（解析 + 序列化同源）
export {
  parseAgentFile,
  parseFrontmatter,
  extractPrompt,
  normalizeHead,
  serializeAgentClass,
  agentFileName,
  agentFileOf,
  AGENT_KNOWN_KEYS,
} from './agentFile'
export type { AgentFrontmatter, ParsedAgentFile } from './agentFile'
