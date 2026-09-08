// ============================================================
// core/context/strategies/cortex/schema.ts —— cortex 数据形状与纯校验
//
// 三层记忆的"合同层"：dreamAt 基因解析（类 custom.cortex）、LTM JSON
// 结构校验、**dreamer 回信格式与解析**、笔记名/目录渲染——全部纯函数
// （离线可测，无 IO 无状态）。机制详情 = docs/architecture.md §2.2b。
// ============================================================

import type { ModelRef } from '../../../gateway'

/** cortex 基因参数（类 custom.cortex 槽；两件，无硬预算——提示词指导）。 */
export interface CortexSettings {
  /** 专注度线（估算 tokens；触发做梦 + 天然兼作重启线与频控）。 */
  readonly dreamAt: number
  /** dreamer 模型（缺省 inherit 走出生链）。 */
  readonly consolidateModel?: ModelRef
}

/** dreamAt 缺省值（256k 自愿收紧档；窗口大的模型在类基因里自调）。 */
export const DEFAULT_DREAM_AT = 262_144

/** 解析类 custom.cortex（宽松读取 + clamp：≤ window×0.9，非法值回缺省）。
 *  warn 回调供调用方去重上报（per-host 首见时）。 */
export function parseCortexSettings(
  custom: Readonly<Record<string, unknown>> | undefined,
  window: number,
  warn?: (message: string) => void,
): CortexSettings {
  const raw = custom?.cortex
  let dreamAt = DEFAULT_DREAM_AT
  let consolidateModel: ModelRef | undefined
  if (raw !== undefined && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>
    if (typeof r.dreamAt === 'number' && Number.isFinite(r.dreamAt) && r.dreamAt > 0) {
      dreamAt = r.dreamAt
    } else if (r.dreamAt !== undefined) {
      warn?.(`custom.cortex.dreamAt 非正数（${String(r.dreamAt)}），回缺省 ${String(DEFAULT_DREAM_AT)}`)
    }
    const m = r.consolidateModel
    if (m !== undefined) {
      if (typeof m === 'object' && m !== null && !Array.isArray(m)) {
        const mm = m as Record<string, unknown>
        if (typeof mm.provider === 'string' && typeof mm.id === 'string') {
          consolidateModel = { provider: mm.provider, id: mm.id }
        } else {
          warn?.('custom.cortex.consolidateModel 形状不合法（需 {provider,id}），忽略')
        }
      } else {
        warn?.('custom.cortex.consolidateModel 不是 {provider,id} 对象，忽略')
      }
    }
  } else if (raw !== undefined) {
    warn?.('custom.cortex 不是对象，整段忽略')
  }
  const ceiling = Math.max(1, Math.floor(window * 0.9))
  if (dreamAt > ceiling) {
    warn?.(`dreamAt=${String(dreamAt)} 超窗口 90%（${String(ceiling)}），clamp`)
    dreamAt = ceiling
  }
  return { dreamAt, ...(consolidateModel !== undefined ? { consolidateModel } : {}) }
}

/** LTM 单条记忆（provenance 必填——有损毒性对策，plan §7）。 */
export interface LtmItem {
  readonly text: string
  readonly source: string
}

export const LTM_MAX_ITEMS = 60
export const LTM_TEXT_MAX = 600
export const LTM_SOURCE_MAX = 120

/** 校验 dream 上报的 LTM（工具 validate 复用；返回错误信息或 undefined）。 */
export function validateLtm(input: unknown): string | undefined {
  if (!Array.isArray(input)) return 'items 必须是数组'
  if (input.length > LTM_MAX_ITEMS) return `条目数 ${String(input.length)} 超上限 ${String(LTM_MAX_ITEMS)}（LTM 要精不要全）`
  for (const [i, item] of input.entries()) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return `items[${String(i)}] 必须是对象 {text, source}`
    }
    const it = item as Record<string, unknown>
    if (typeof it.text !== 'string' || it.text.trim() === '') return `items[${String(i)}].text 必填非空字符串`
    if (it.text.length > LTM_TEXT_MAX) return `items[${String(i)}].text 超 ${String(LTM_TEXT_MAX)} 字符`
    if (typeof it.source !== 'string' || it.source.trim() === '') {
      return `items[${String(i)}].source 必填（provenance，如 "t12 用户要求"——记忆可能过时，来源供回查）`
    }
    if (it.source.length > LTM_SOURCE_MAX) return `items[${String(i)}].source 超 ${String(LTM_SOURCE_MAX)} 字符`
  }
  return undefined
}

/** 笔记文件名规则（主题名；小写短横线；保留字避开镜像文件 .memory.json）。 */
export const NOTE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/
const NOTE_RESERVED = new Set(['memory'])

export function validateNoteName(name: unknown): string | undefined {
  if (typeof name !== 'string') return 'name 必须是字符串'
  if (!NOTE_NAME_RE.test(name)) return 'name 需匹配 ^[a-z0-9][a-z0-9-]{0,40}$（小写字母数字短横线）'
  if (NOTE_RESERVED.has(name)) return `name "${name}" 是保留字`
  return undefined
}

/** 目录条目（文件正文的衍生代理）。 */
export interface TocEntry {
  readonly name: string
  readonly summary: string
}

/** 笔记正文首句摘要（目录行原料；≤80 字符）。 */
export function firstLineSummary(markdown: string): string {
  for (const line of markdown.split('\n')) {
    const t = line.replace(/^#+\s*/, '').trim()
    if (t !== '') return t.length > 80 ? `${t.slice(0, 80)}…` : t
  }
  return '(空)'
}

/** 目录行渲染（一行一篇：`主题 —— 首句`；稳定排序）。 */
export function renderToc(entries: readonly TocEntry[]): string {
  if (entries.length === 0) return '(尚无笔记——用 cortex_add_note 沉淀值得脱离上下文的知识)'
  return [...entries]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => `${e.name} —— ${e.summary}`)
    .join('\n')
}

/** LTM 行渲染（JSON pretty——仓库行/镜像文件同形）。 */
export function renderLtm(items: readonly LtmItem[]): string {
  return JSON.stringify(items, null, 1)
}

// ---------- dreamer 回信合同（输出 = 回信；替代旧 cortex_set_* 工具面） ----------

/** 回信格式模板（dreamer 提示词与纠错信共用——格式定义单点）。 */
export const DREAM_REPORT_FORMAT =
  '<cortex_dream>\n<ltm>\n[{"text": "记忆正文", "source": "t12 用户要求"}]\n</ltm>\n<stm>\n短期记忆 markdown 全文\n</stm>\n</cortex_dream>'

/** 解析成功的梦报告（双段齐 = 轮替原料）。 */
export interface DreamReport {
  readonly ltm: readonly LtmItem[]
  readonly stm: string
}

export interface DreamReportError {
  readonly error: string
}

/**
 * 解析 dreamer 回信为梦报告（纯函数，schema 校验即 spawn validate 回调）。
 * 宽容面：外围废话（找外壳）、ltm 段代码围栏；严格面：双段齐、JSON 合法、
 * validateLtm 全检、stm 非空——不合 = 错误说明进纠错信（C2 回信循环）。
 */
export function parseDreamReport(raw: string): DreamReport | DreamReportError {
  const outer = /<cortex_dream>[\s\S]*<\/cortex_dream>/.exec(raw)
  if (outer === null) {
    return { error: '回信中找不到 <cortex_dream>…</cortex_dream> 报告外壳——你的最终回信本体就是报告，格式：' + DREAM_REPORT_FORMAT }
  }
  const body = outer[0]
  const ltm = /<ltm>([\s\S]*?)<\/ltm>/.exec(body)
  if (ltm === null) return { error: '缺 <ltm> 段（LTM JSON 数组须完整在段内）' }
  const stm = /<stm>([\s\S]*?)<\/stm>/.exec(body)
  if (stm === null) return { error: '缺 <stm> 段（短期记忆 markdown 须完整在段内）' }
  const ltmText = (ltm[1] ?? '').trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(ltmText)
  } catch (cause) {
    return { error: `<ltm> 段不是合法 JSON（${cause instanceof Error ? cause.message : String(cause)}）` }
  }
  const bad = validateLtm(parsed)
  if (bad !== undefined) return { error: `<ltm> 段校验失败：${bad}` }
  const stmText = (stm[1] ?? '').trim()
  if (stmText === '') return { error: '<stm> 段为空（当次无事也须写明当前状态与待办）' }
  return { ltm: parsed as LtmItem[], stm: stmText }
}
