// ============================================================
// core/context/strategies/cortex/memory.ts —— 记忆组读写（plan §2 载体）
//
// 记忆组 = 仓库里的真实行（教学样板即"真实写入"）：
//   锚点（user, tag='cortex'，组创建一次写、永不轮替）
//   载体（assistant, tag='cortex'，虚拟调用 cortex_load_ltm/notes/stm）
//   三 tool 行（tag='ltm'/'note'/'stm'，toolCallId 配对）
// 水位线**无独立存储**：= 现行记忆组的最大 turn，打包范围由行序天然
// 推导（重启/多进程零漂移）。轮替 = markInvalid 旧组三行 + 快照实时
// 轮 → append 新组（invalid 链 = 记忆演变史，可审计可回溯）。
// 目录行（note）例外走 in-place 改写（纯内容再生，不动结构——避免
// 目录 churn 顶翻水位线）。
// ============================================================

import type { ChatMessage } from '../../../gateway'
import type { StoredMessage } from '../../types'
import type { StrategyApi } from '../types'
import type { LtmItem, TocEntry } from './schema'
import { firstLineSummary, renderToc } from './schema'

/** 记忆族 tag（组装合法面：卸载/清理选择集必须排除这些行）。 */
export const MEMORY_TAGS: ReadonlySet<string> = new Set(['cortex', 'ltm', 'note', 'stm'])

export const MEM_DIR_NAME = '.stem/mem'

/** 锚点全文（策略自写的常驻介绍——教学样板的"讲课文"，plan §2）。 */
export const ANCHOR_TEXT =
  '<stem_cortex>你的上下文策略为 cortex（三层外挂记忆 + 做梦固化）。' +
  '紧随其后的三组工具结果是记忆载入示范（系统真实注入，非你可调用之物）：' +
  'ltm=长期记忆（跨任务事实/教训/承诺，每条带来源）；note=主题笔记目录' +
  '（正文在 .stem/mem/<id>/<主题>.md，用 read 工具读全文）；stm=短期记忆' +
  '（"醒着的我刚才在干嘛"）。你的操作面：' +
  'cortex_add_note/cortex_del_note 随时沉淀或清理主题笔记（本策略自带操作面）；' +
  'context_remove/context_edit 随时整理自己的对话轮（删除是归档非销毁）；' +
  'context_apply(action="dream") 可提前做梦固化记忆。上下文尺寸不必自己盯——' +
  '积累过线时系统自动做梦（dreamer 全景重放后重写三层并归档旧对话轮）。' +
  '注意：记忆可能过时，关键决策前回语料/笔记核实（每条 LTM 的 source 即入口）。</stem_cortex>'

/** 现行记忆组的四行（锚点独立返回；未做梦 = undefined）。 */
export interface MemoryGroup {
  readonly anchor: StoredMessage | undefined
  readonly carrier: StoredMessage | undefined
  readonly ltm: StoredMessage | undefined
  readonly note: StoredMessage | undefined
  readonly stm: StoredMessage | undefined
  /** 组水位 = 现行组行的最大 turn（无组 = 0）。 */
  readonly watermark: number
  /** 轮替时应作废的行（载体+三 tool 行；锚点与 note 行除外——见 rotate）。 */
  readonly replaceableIds: readonly string[]
}

/** 从有效行提取现行记忆组（各 tag 取最新一行）。 */
export function currentGroup(valid: readonly StoredMessage[]): MemoryGroup {
  let anchor: StoredMessage | undefined
  let carrier: StoredMessage | undefined
  let ltm: StoredMessage | undefined
  let note: StoredMessage | undefined
  let stm: StoredMessage | undefined
  for (const row of valid) {
    switch (row.tag) {
      case 'cortex':
        if (row.message.role === 'user') anchor = row
        else carrier = row
        break
      case 'ltm': ltm = row; break
      case 'note': note = row; break
      case 'stm': stm = row; break
    }
  }
  const rows = [anchor, carrier, ltm, note, stm].filter((r): r is StoredMessage => r !== undefined)
  const watermark = rows.reduce((acc, r) => Math.max(acc, r.turn), 0)
  // 轮替作废：旧组除锚点外全部（note 行也随组重发——轮替是全组事务）。
  const replaceableIds = [carrier, ltm, note, stm].filter((r): r is StoredMessage => r !== undefined).map((r) => r.id)
  return { anchor, carrier, ltm, note, stm, watermark, replaceableIds }
}

/** 快照：本轮梦要归档的实时行 + 打包原料。 */
export interface DreamSnapshot {
  readonly group: MemoryGroup
  /** 水位线之后的全部非系统有效行（含模型自裁轮——归档它们；tag 族已排除）。 */
  readonly liveRows: readonly StoredMessage[]
}

export function takeSnapshot(api: StrategyApi): DreamSnapshot {
  const valid = api.listValid()
  const group = currentGroup(valid)
  const liveRows = valid.filter(
    (row) => row.message.role !== 'system' && !(row.tag !== undefined && MEMORY_TAGS.has(row.tag)) && row.turn > group.watermark,
  )
  return { group, liveRows }
}

/** LTM 行内容解析（坏 JSON = 空库起步，warn 由调用方处理）。 */
export function parseLtmRow(content: string | undefined): LtmItem[] | undefined {
  if (content === undefined || content.trim() === '') return undefined
  try {
    const parsed: unknown = JSON.parse(content)
    if (!Array.isArray(parsed)) return undefined
    const items: LtmItem[] = []
    for (const item of parsed) {
      if (item !== null && typeof item === 'object' && typeof (item as LtmItem).text === 'string') {
        items.push({ text: (item as LtmItem).text, source: typeof (item as LtmItem).source === 'string' ? (item as LtmItem).source : '?' })
      }
    }
    return items
  } catch {
    return undefined
  }
}

/** 轮替事务落笔：作废旧组与快照实时轮，写入新组（锚点缺位补写）。
 *  返回作废行数（事件账目）。 */
export async function rotateGroup(
  api: StrategyApi,
  snapshot: DreamSnapshot,
  ltm: readonly LtmItem[],
  stm: string,
  toc: string,
  ltmRendered: string,
): Promise<number> {
  const idsToInvalidate = [...snapshot.group.replaceableIds, ...snapshot.liveRows.map((r) => r.id)]
  if (idsToInvalidate.length > 0) await api.markInvalid(idsToInvalidate)
  if (snapshot.group.anchor === undefined) {
    await api.append({ role: 'user', content: ANCHOR_TEXT }, 'cortex')
  }
  const seq = Date.now().toString(36)
  const callLtm = `cortex-ltm-${seq}`
  const callNote = `cortex-note-${seq}`
  const callStm = `cortex-stm-${seq}`
  const carrier: ChatMessage = {
    role: 'assistant',
    content: '载入我的三层记忆（cortex 系统注入的例行载入）。',
    toolCalls: [
      { id: callLtm, name: 'cortex_load_ltm', arguments: '{}' },
      { id: callNote, name: 'cortex_load_notes', arguments: '{}' },
      { id: callStm, name: 'cortex_load_stm', arguments: '{}' },
    ],
  }
  await api.append(carrier, 'cortex')
  await api.append({ role: 'tool', toolCallId: callLtm, content: ltmRendered }, 'ltm')
  await api.append({ role: 'tool', toolCallId: callNote, content: toc }, 'note')
  await api.append({ role: 'tool', toolCallId: callStm, content: stm }, 'stm')
  return idsToInvalidate.length
}

/** 读盘生成最新目录文本（目录不存在/坏文件宽容）。 */
export async function buildToc(fs: { listFiles: (d: string) => Promise<readonly string[]>; readText: (f: string) => Promise<string> }, memDir: string): Promise<string> {
  let names: readonly string[] = []
  try {
    names = await fs.listFiles(memDir)
  } catch {
    names = []
  }
  const entries: TocEntry[] = []
  for (const file of names) {
    const name = file.replace(/\.md$/, '')
    if (name === '.memory' || file === '.memory.json') continue // 镜像文件不算笔记
    try {
      const body = await fs.readText(`${memDir}/${file}`)
      if (body.trim() === '') continue // 空篇 = 删除墓碑，不入目录
      entries.push({ name, summary: firstLineSummary(body) })
    } catch {
      // 文件瞬删竞态：跳过。
    }
  }
  return renderToc(entries)
}

/** 目录行再生：note 行与磁盘实际目录失配时 in-place 改写（无行 churn）。 */
export async function refreshTocRow(api: StrategyApi, fs: { listFiles: (d: string) => Promise<readonly string[]>; readText: (f: string) => Promise<string> }, memDir: string): Promise<boolean> {
  const noteRow = currentGroup(api.listValid()).note
  if (noteRow === undefined || api.updateMessage === undefined) return false
  const toc = await buildToc(fs, memDir)
  const current = typeof noteRow.message.content === 'string' ? noteRow.message.content : ''
  if (current === toc) return false
  await api.updateMessage(noteRow.id, { role: 'tool', toolCallId: noteRow.message.toolCallId ?? '', content: toc })
  return true
}
