// ============================================================
// shell/config/index.ts —— 唯一出口（只 re-export）
// ============================================================

export {
  resolveConfigPaths,
  createNodeConfigStore,
  createNodeInitFs,
  nodeToolLoader,
  createNodeConfigBundle,
  FALLBACK_MODEL,
} from './nodeConfig'
