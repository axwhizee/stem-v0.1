// ============================================================
// core/context/strategies/cortex/dream.ts —— 做梦（记忆固化事务）
//
// 流程（plan §3）：process 阈值判定 → runDream 拿全局锁 → 快照打包
// （现行三层 + 水位线后实时轮 + 有变化的笔记正文）→ api.spawn 巡检
// worker（二段事务：先 set_ltm 后 set_stm，期间可 add/del_note——
// 全部落 staging）→ 收口：双 set 齐才轮替 + 镜像 + 事件；半途/异常
// = 不轮替、锁释放、下一封信自然重触发。
// spawn 全程在后台 promise 里（process 不 await——绝不停等拦信）。
// ============================================================

import type { ModelRef } from '../../../gateway'
import type { StrategyAgentSpec, StrategyApi } from '../types'
import type { CortexRuntime } from './state'
import type { CortexSettings } from './schema'
import type { DreamSnapshot } from './memory'
import { buildToc, rotateGroup, takeSnapshot } from './memory'
import { renderLtm } from './schema'
import type { StrategyInitFs } from '../types'

/** dream worker 出生档案（受限 grant 表——plan §3；role 面板不设 tools 免锁子孙）。 */
export const DREAM_WORKER_SPEC: StrategyAgentSpec = {
  className: 'cortex-dream',
  description: 'cortex 做梦 worker：全景重放后重写三层记忆的专职任务 agent（策略机制创建，一拍一生死）',
  systemPrompt:
    '你是 stem 系统的"梦"——宿主 agent 的睡眠整理过程，不是对话者。' +
    '你会收到宿主的完整记忆现状与自上次梦以来的全部对话回放。任务是把它们固化为三层记忆。' +
    '严格两段式事务（顺序即依赖）：' +
    '第一步，通读回放与笔记，调用 cortex_set_ltm 重写长期记忆——全量替换而非追加：' +
    '保留跨任务仍核心的身份/环境事实/教训/进行承诺，淘汰过时重复项；' +
    '每条带 source 来源（如 "t12 用户要求"）；宁精勿全（数十条内，text ≤600 字符）。' +
    '第二步，调用 cortex_set_stm 重写短期记忆——回答"醒着的我刚才在干嘛"：' +
    '当前任务与目标、进度到哪、未兑现的承诺/待办、眼前必须知道的事实；markdown，自含上下文。' +
    '途中若发现值得脱离上下文长期外挂的知识/做法，用 cortex_add_note 沉淀成主题笔记；' +
    '发现明显过时的笔记用 cortex_del_note 删除。' +
    '两段都完成后，只输出一句话简报（不要复述记忆内容）。' +
    '铁律：不得编造回放中不存在的事实；不确定的记忆删除或降权，宁可丢失不可污染。',
  tools: {
    cortex_set_ltm: 'allow',
    cortex_set_stm: 'allow',
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

/** 首信：现状 + 回放 + 指令回显。 */
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
    '## 现行长期记忆（LTM，将按你的 cortex_set_ltm 全量重写）',
    ltmText,
    '',
    '## 现行短期记忆（STM，将按你的 cortex_set_stm 全量重写）',
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
    '现在开始：第一段 cortex_set_ltm，第二段 cortex_set_stm（顺序即事务），途中可增删笔记。完成后输出一句话简报。',
  ].join('\n')
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
  runtime.begin(hostId)
  try {
    const fs = deps.fsRef()
    const snapshot = takeSnapshot(api)
    const toc = await buildTocSafe(fs, deps.memDirOf(hostId))
    // 打包时带上的笔记正文 = 磁盘全部（体积由 dreamAt 线间接控制，无硬预算）。
    const noteBodies = await readAllNotes(fs, deps.memDirOf(hostId))
    const spec: StrategyAgentSpec =
      settings.consolidateModel !== undefined ? { ...DREAM_WORKER_SPEC, model: settings.consolidateModel } : DREAM_WORKER_SPEC
    await api.spawn(buildDreamTask(snapshot, toc, noteBodies), spec)

    // 收口：消费暂存（worker 操作以 host 名义落盘）。
    const staged = runtime.drain()
    let notesTouched = 0
    if (fs?.writeText !== undefined && fs.ensureDir !== undefined) {
      const dir = deps.memDirOf(hostId)
      await fs.ensureDir(dir)
      for (const note of staged.notes) {
        try {
          if (note.op === 'add' && note.content !== undefined) {
            await fs.writeText(`${dir}/${note.name}.md`, note.content)
            notesTouched += 1
          } else if (note.op === 'del') {
            // 无 remove 端口的删除语义：置空 = 墓碑（buildToc/readAllNotes 过滤空篇）。
            await fs.writeText(`${dir}/${note.name}.md`, '')
            notesTouched += 1
          }
        } catch {
          // 单篇失败不拦事务（下次巡检目录以磁盘为准自纠）。
        }
      }
    } else if (staged.notes.length > 0 && !runtime.host(hostId).warned.has('ro-fs')) {
      runtime.host(hostId).warned.add('ro-fs')
      api.log({ type: 'context.dreamed', agentId: hostId, consolidated: false, invalidRows: 0, notesTouched: 0, message: '只读空间：笔记操作未落盘' })
    }

    if (staged.ltm === undefined || staged.stm === undefined) {
      // 半途而废：不轮替、水位线不动，下一拍自然重触发。
      const why = staged.ltm === undefined && staged.stm === undefined ? 'worker 零产出' : staged.ltm === undefined ? '缺 cortex_set_ltm' : '缺 cortex_set_stm'
      return { consolidated: false, invalidRows: 0, notesTouched, message: `梦未完成（${why}），记忆未轮替` }
    }
    const ltmRendered = renderLtm(staged.ltm)
    const newToc = await buildTocSafe(fs, deps.memDirOf(hostId))
    const invalidRows = await rotateGroup(api, snapshot, staged.ltm, staged.stm, newToc, ltmRendered)
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
    return {
      consolidated: true,
      invalidRows,
      notesTouched,
      message: `梦成：LTM ${String(staged.ltm.length)} 条重写，归档 ${String(invalidRows)} 行，笔记触碰 ${String(notesTouched)} 篇`,
    }
  } catch (cause) {
    runtime.abort()
    const message = cause instanceof Error ? cause.message : JSON.stringify(cause)
    return { consolidated: false, invalidRows: 0, notesTouched: 0, message: `梦中断（${message}），记忆未轮替` }
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
