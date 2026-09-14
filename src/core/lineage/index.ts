// ============================================================
// core/lineage/index.ts —— 唯一出口（只 re-export，不写逻辑）
// ============================================================

export type {
  LineageTree,
  LineageTreeOptions,
  LineageBindEntry,
  ModelBinding,
  ModelBindInput,
  ModelOrigin,
  NodeConfig,
  AgentNodeView,
} from './LineageTree'
export { DefaultLineageTree } from './LineageTree'

export type { AccessLedger, AccessProfile, AccessBindEntry, AccessBindMode } from './AccessLedger'
export { DefaultAccessLedger } from './AccessLedger'
