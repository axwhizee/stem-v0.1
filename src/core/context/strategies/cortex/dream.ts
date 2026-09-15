// ============================================================
// core/context/strategies/cortex/dream.ts —— 做梦（记忆固化事务）
//
// 流程：process 阈值判定 → runDream 拿全局锁 → 快照打包（现行三层 +
// 水位线后实时轮 + 全部笔记正文）→ spawn dreamer（**contextRefs 式
// 全景重放：素材全在首信文本里**；清单收敛 = 只剩笔记两键）→
// **回信即交付物**：spawn validate 用 parseDreamReport 校 schema，
// 不合 = 纠错信循环（生命周期内最多 2 轮）；末件仍不合 = 半途（不轮替、
// 锁释放、下一封信自然重触发）。双份齐 → 收口段执行轮替（旧组+快照
// 实时行 markInvalid、新组 append、镜像、事件——二段事务的原子性住在
// 这里）。笔记不经回信：dreamer 调 add/del_note 当场以 host 名义落盘。
// spawn 全程在后台 promise 里（process 不 await——绝不停等拦信）。
// ============================================================

import type { StrategyApi } from '../types'
import type { AgentClass } from '../../../kernel/types'
import { makeAgentClassID } from '../../../kernel/types'
import type { CortexRuntime } from './state'
import type { CortexSettings, DreamReport } from './schema'
import { DREAM_REPORT_FORMAT, parseDreamReport, renderLtm } from './schema'
import type { DreamSnapshot } from './memory'
import { buildToc, rotateGroup, takeSnapshot } from './memory'
import type { StrategyInitFs } from '../types'

/**
 * dreamer 出生档案（原 dream worker/cortex-dream，s11 更名）。
 * tools 清单收敛 = 只剩笔记两键（记忆写回不经工具——回信即交付物）；
 * 其父 role 刻意不设 tools（匿名不封顶），grant 逐键仍被出生表钳制。
 */
export const DREAMER_SPEC: AgentClass = {
  name: makeAgentClassID('cortex-dreamer'),
  description: 'cortex dreamer：全景重放后重写三层记忆的专职任务 agent（策略机制创建，一拍一生死）',
  systemPrompt:
    '你是 stem 系统的"梦"——宿主 agent 的睡眠整理过程，不是对话者。' +
    '你会收到宿主的完整记忆现状与自上次梦以来的全部对话回放。任务是把它们固化为三层记忆。' +
    '工作方式：途中可用 cortex_add_note 沉淀值得脱离上下文长期外挂的知识/做法、' +
    'cortex_del_note 删除明显过时的笔记（当场落盘，算入本次梦）；' +
    '除此之外的一切交付都装进你的**最终回信**——格式严格的梦报告：\n' +
    DREAM_REPORT_FORMAT + '\n' +
    '段规：ltm 段 = JSON 数组（全量替换而非追加：保留跨任务仍核心的身份/环境事实/' +
    '教训/进行承诺，淘汰过时重复项；每条带 source 来源如 "t12 用户要求"；' +
    '宁精勿全，≤60 条，text ≤600 字符）；stm 段 = markdown 全文，回答' +
    '"醒着的我刚才在干嘛"（当前任务与目标、进度、未兑现的承诺/待办、眼前必须知道的事实；' +
    '自含上下文）。外壳标签之外不要输出任何多余文字。' +
    '若系统判定报告不合格会给你纠错信——按纠错信重发**完整**报告（两段都要）。' +
    '铁律：不得编造回放中不存在的事实；不确定的记忆删除或降权，宁可丢失不可污染。',
  tools: {
    cortex_add_note: 'allow',
    cortex_del_note: 'allow',
  },
  sendCountdown: 0,
  contextStrategy: 'none',
}

/** 打包渲染单行（全量重放不掐尾——1M 窗模型，预算在提示词层）。 */
function renderRow(row: DreamSnapshot['liveRows'][number]): string {
  const msg = row.message
  const body = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
  const calls =
    msg.toolCalls !== undefined && msg.toolCalls.length > 0
      ? ` →[calls: ${msg.toolCalls.map((c) => `${c.name}(${c.arguments.slice(0, 200)})`).join('; ')}]`
      : ''
  const tag = row.tag !== undefined && row.tag !== '' ? `[${row.tag}] ` : ''
  return `(${String(row.turn)}) ${tag}${msg.role}: ${body}${calls}`
}

/** 首信：现状 + 回放 + 交付指令（全景重放——dreamer 的世界 = 这封信）。 */
export function buildDreamTask(
  snapshot: DreamSnapshot,
  toc: string,
  noteBodies: Readonly<Record<string, string>>,
): string {
  const g = snapshot.group
  const ltmText = g.ltm !== undefined ? (typeof g.ltm.message.content === 'string' ? g.ltm.message.content : '') : '(首次做梦——尚无长期记忆)'
  const stmText = g.stm !== undefined ? (typeof g.stm.message.content === 'string' ? g.stm.message.content : '') : '(首次做梦——尚无短期记忆)'
  const transcript = snapshot.liveRows.map(renderRow).join('\n')
  const notes = Object.entries(noteBodies)
  const notesBlock = notes.length === 0
    ? '(无外挂笔记文件)'
    : notes.map(([name, body]) => `### 笔记 ${name}\n${body}`).join('\n\n')
  return [
    '# 梦境素材',
    '',
    '## 现行长期记忆（LTM，你的报告将全量重写它）',
    ltmText,
    '',
    '## 现行短期记忆（STM，你的报告将全量重写它）',
    stmText,
    '',
    '## 现行笔记目录',
    toc,
    '',
    '## 笔记正文',
    notesBlock,
    '',
    `## 自上次固化以来的对话回放（${String(snapshot.liveRows.length)} 行）`,
    transcript === '' ? '(无新行——若确实无事，仍须重写两段记忆以保持格式)' : transcript,
    '',
    '---',
    '现在开始整理。途中可增删笔记；最终回信 = 梦报告（两段齐）：',
    DREAM_REPORT_FORMAT,
  ].join('\n')
}

/** 回信 → 梦报告 validate（spawn 纠错循环回调；通过 = undefined）。 */
export function validateDreamReport(reply: string): string | undefined {
  const parsed = parseDreamReport(reply)
  return 'error' in parsed ? parsed.error : undefined
}

export interface DreamDeps {
  readonly runtime: CortexRuntime
  /** init 期捕获的 fs（agent 直写与镜像共用）。 */
  readonly fsRef: () => StrategyInitFs | undefined
  readonly projectRoot: string
  readonly memDirOf: (agentId: string) => string
}

export interface DreamOutcome {
  readonly consolidated: boolean
  readonly invalidRows: number
  readonly notesTouched: number
  readonly message: string
}

function reportOf(parsed: DreamReport | { error: string }): DreamReport | undefined {
  return 'error' in parsed ? undefined : parsed
}

/**
 * 执行一场梦（同步 await 收口——process 用 fire-and-forget 包装它，
 * actions.dream 直接 await 它给用户回报串）。全局锁由 runtime 保证。
 */
export async function runDream(api: StrategyApi, settings: CortexSettings, deps: DreamDeps): Promise<DreamOutcome> {
  const { runtime } = deps
  if (runtime.dream !== undefined) {
    return { consolidated: false, invalidRows: 0, notesTouched: 0, message: '已有梦在途（全局串行），本场跳过' }
  }
  const hostId = api.agentId
  const token = runtime.begin(hostId)
  try {
    const fs = deps.fsRef()
    const snapshot = takeSnapshot(api)
    const toc = await buildTocSafe(fs, deps.memDirOf(hostId))
    // 打包时带上的笔记正文 = 磁盘全部（体积由 dreamAt 线间接控制，无硬预算）。
    const noteBodies = await readAllNotes(fs, deps.memDirOf(hostId))
    // dreamer 模型随出生链（父 role → 宿主）；无独立 consolidateModel。
    const spec: AgentClass = DREAMER_SPEC
    // 回信即交付物：validate 不过 = 同一 dreamer 收纠错信再改（≤2 轮）；
    // 末件仍不过 = 半途（不轮替）。
    const reply = await api.spawn(buildDreamTask(snapshot, toc, noteBodies), spec, { validate: validateDreamReport })
    const report = reportOf(parseDreamReport(reply))
    if (report === undefined) {
      return { consolidated: false, invalidRows: 0, notesTouched: token.notesTouched, message: '梦未完成（回信不合 schema，纠错轮已尽），记忆未轮替' }
    }
    const ltmRendered = renderLtm(report.ltm)
    const newToc = await buildTocSafe(fs, deps.memDirOf(hostId))
    const invalidRows = await rotateGroup(api, snapshot, report.ltm, report.stm, newToc, ltmRendered)
    // 镜像：单向、及时、永不回灌（灾难恢复通道 = 人工）。
    if (fs?.writeText !== undefined && fs.ensureDir !== undefined) {
      try {
        const dir = deps.memDirOf(hostId)
        await fs.ensureDir(dir)
        await fs.writeText(`${dir}/.memory.json`, ltmRendered)
      } catch {
        // 镜像失败不影响事务本体（仓库行是真相）。
      }
    }
    const notesTouched = token.notesTouched
    return {
      consolidated: true,
      invalidRows,
      notesTouched,
      message: `梦成：LTM ${String(report.ltm.length)} 条重写，归档 ${String(invalidRows)} 行，笔记触碰 ${String(notesTouched)} 篇`,
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : JSON.stringify(cause)
    return { consolidated: false, invalidRows: 0, notesTouched: 0, message: `梦中断（${message}），记忆未轮替` }
  } finally {
    runtime.end() // 成败皆释放全局锁（防死锁；计数已在各 return 前结出）
  }
}

async function buildTocSafe(fs: StrategyInitFs | undefined, memDir: string): Promise<string> {
  if (fs === undefined) return '(fs 不可用)'
  return buildToc(fs, memDir)
}

/** 读磁盘全部笔记正文（≤64 篇防极端；按名排序保确定性）。 */
async function readAllNotes(fs: StrategyInitFs | undefined, memDir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  if (fs === undefined) return out
  let names: readonly string[] = []
  try {
    names = await fs.listFiles(memDir)
  } catch {
    return out
  }
  for (const file of names.slice(0, 64)) {
    if (!file.endsWith('.md') || file === '.memory.json') continue
    const name = file.replace(/\.md$/, '')
    if (name === '.memory') continue
    try {
      const body = await fs.readText(`${memDir}/${file}`)
      if (body.trim() === '') continue // 墓碑篇（del 语义）不入打包
      out[name] = body
    } catch {
      // 瞬删竞态容忍。
    }
  }
  return out
}
