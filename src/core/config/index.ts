// ============================================================
// core/config/index.ts —— 唯一出口（只 re-export，不写逻辑）
// ============================================================

export type {
  StemConfig,
  StemProviderConfig,
  StemUserClass,
  StemContextConfig,
  StemBashConfig,
  ConfigLoadResult,
  ConfigError,
} from './types'
export { parseConfigText, normalizeConfig } from './parse'
export { DEFAULT_CONFIG_TEXT, defaultStemConfig } from './defaults'
export type { ConfigStore, ConfigPaths } from './store'
