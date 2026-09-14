// ============================================================
// core/context/strategies/cortex/index.ts —— cortex 策略唯一出口
// ============================================================

export { createCortexStrategy, CORTEX_ROLE } from './cortex'
export { DREAMER_SPEC, buildDreamTask, validateDreamReport, runDream } from './dream'
export type { DreamOutcome, DreamDeps } from './dream'
export { DEFAULT_DREAM_AT, resolveDreamAt, validateLtm, validateNoteName, renderToc, renderLtm, firstLineSummary } from './schema'
export type { CortexSettings, LtmItem, TocEntry } from './schema'
export { currentGroup, takeSnapshot, ANCHOR_TEXT, MEM_DIR_NAME, MEMORY_TAGS, buildToc } from './memory'
export { CortexRuntime } from './state'
export { createCortexTools } from './tools'
export type { NoteSaver } from './tools'
