// ============================================================
// core/lineage/index.ts —— 唯一出口（只 re-export）
// ============================================================

export type { LineageTree, LineageTreeOptions } from './LineageTree'
export { DefaultLineageTree } from './LineageTree'

export type { AccessLedger, AccessProfile, AccessBindEntry, AccessBindMode } from './AccessLedger'
export { DefaultAccessLedger } from './AccessLedger'