// ============================================================
// core/context/strategies/cortex/tools.ts —— cortex 工具面（四枚）
//
// 生命周期角色（plan §2 教学样板的"真名"侧；读侧 cortex_load_* 是
// 组装轮里的虚拟名，不注册——幻觉点名 = unknown 无害）：
//   cortex_set_ltm / cortex_set_stm —— dream worker 专属（根表不列 =
//     全树匿名 deny；只有 dream 出生档案 grant 放行）。写全局梦 token
//     的 staging（set_stm 是第二 set，落定信号由 runDream 收口判定）。
//   cortex_add_note / cortex_del_note —— agent 与 dream 双可（根表
//     allow 常开）。做梦在途 → 暂存（收口以 host 身份落盘；worker 的
//     笔记进 host 目录）；平时无梦 → 立即落盘 caller 自己的目录。
// 权限执行在 kernel 工具链（族谱台账），本模块零鉴权零特权——身份
// 分流只靠全局梦 token（state.ts 串行裁决），工具面纯同步。
// ============================================================

import type { ToolCapability } from '../../../tools'
import type { CortexRuntime } from './state'
import type { LtmItem } from './schema'
import { validateLtm, validateNoteName } from './schema'

/** 落盘回调（agent 直写通道用；cortex.ts 注入，工具不碰 fs）。 */
export interface NoteSaver {
  readonly add: (agentId: string, name: string, content: string) => Promise<void>
  readonly del: (agentId: string, name: string) => Promise<void>
}

function objArgs(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined
}

export function createCortexTools(runtime: CortexRuntime, saver: NoteSaver): readonly ToolCapability[] {
  const setLtm: ToolCapability = {
    id: 'cortex_set_ltm',
    kind: 'custom',
    description:
      '【cortex·做梦专属】重写长期记忆（LTM）为给定条目集。全量替换而非追加：' +
      '保留仍然核心的身份/环境事实/教训/进行承诺，淘汰过时与重复项；' +
      '每条必须带 source（来源轮次/出处，如 "t12 用户要求"）——记忆可能过时，来源供回查核实。',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description:
            'LTM 全量条目（≤60 条）；每条为对象 {text, source}：text=记忆正文（≤600 字符，自含上下文，写给"醒来后的我"）；source=provenance 来源轮次/出处（≤120 字符，如 "t12 用户要求"）',
          items: { type: 'object' },
        },
      },
      required: ['items'],
    },
    validate: (input) => {
      const a = objArgs(input)
      if (!a) return '需要 {items: [...]}'
      return validateLtm(a.items)
    },
    execute: (input, ctx) => {
      if (runtime.dream === undefined) {
        return { text: '拒绝：当前没有进行中的梦（cortex_set_ltm 只应答 dream worker；记忆固化是做梦事务的一部分）' }
      }
      const items = (input as { items: LtmItem[] }).items
      runtime.stageLtm(ctx.agentId, items)
      return { text: `LTM 已暂存（${String(items.length)} 条）。继续第二步：基于旧 STM 与对话重写 STM（cortex_set_stm）。` }
    },
  }

  const setStm: ToolCapability = {
    id: 'cortex_set_stm',
    kind: 'custom',
    description:
      '【cortex·做梦专属】重写短期记忆（STM）：当前工作状态（进展/未兑现承诺/眼前事实）。' +
      '这是做梦事务的第二段——落定后旧对话轮将被归档（语料保留），醒来靠这份 STM 接上工作。' +
      '写"醒着的我刚才在干嘛"，不是摘要流水账。',
    parameters: {
      type: 'object',
      properties: {
        state: { type: 'string', description: 'STM markdown 全文（当前任务、进度、待办、关键近期事实）' },
      },
      required: ['state'],
    },
    validate: (input) => {
      const a = objArgs(input)
      if (!a) return '需要 {state: "..."}'
      if (typeof a.state !== 'string' || a.state.trim() === '') return 'state 必填非空字符串'
      return undefined
    },
    execute: (input, ctx) => {
      if (runtime.dream === undefined) {
        return { text: '拒绝：当前没有进行中的梦（cortex_set_stm 只应答 dream worker）' }
      }
      runtime.stageStm(ctx.agentId, (input as { state: string }).state)
      return { text: 'STM 已暂存。两段事务齐备则本次梦境收口（记忆组轮替，旧实时轮归档）。请输出最终简报（一句话）。' }
    },
  }

  const addNote: ToolCapability = {
    id: 'cortex_add_note',
    kind: 'custom',
    description:
      '沉淀一篇主题笔记（markdown 文件，脱离上下文长期外挂；主题目录随每次做梦刷新）。' +
      '值得记录的做法/领域知识/参考细节时调用；一主题一篇，文件名小写短横线（如 api-conventions）。' +
      '正文开头一句写清"这篇讲什么"。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '主题名（^[a-z0-9][a-z0-9-]{0,40}$，避开保留字 memory）' },
        content: { type: 'string', description: '笔记正文（markdown）' },
      },
      required: ['name', 'content'],
    },
    validate: (input) => {
      const a = objArgs(input)
      if (!a) return '需要 {name, content}'
      return validateNoteName(a.name) ?? (typeof a.content === 'string' && a.content.trim() !== '' ? undefined : 'content 必填非空')
    },
    execute: async (input, ctx) => {
      const { name, content } = input as { name: string; content: string }
      if (runtime.isDreamWorker(ctx.agentId)) {
        runtime.stageNote(ctx.agentId, { op: 'add', name, content })
        return { text: `笔记 ${name} 已随梦落账（做梦收口时写入）。` }
      }
      await saver.add(ctx.agentId, name, content)
      return { text: `笔记已落盘：${name}.md（做梦时自动载入目录；读用 read 工具 ${name}.md 全路径）` }
    },
  }

  const delNote: ToolCapability = {
    id: 'cortex_del_note',
    kind: 'custom',
    description: '删除一篇已过时的主题笔记（做梦整理时同款能力）。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '主题名（同 cortex_add_note）' },
      },
      required: ['name'],
    },
    validate: (input) => {
      const a = objArgs(input)
      if (!a) return '需要 {name}'
      return validateNoteName(a.name)
    },
    execute: async (input, ctx) => {
      const { name } = input as { name: string }
      if (runtime.isDreamWorker(ctx.agentId)) {
        runtime.stageNote(ctx.agentId, { op: 'del', name })
        return { text: `删除笔记 ${name} 已随梦落账。` }
      }
      await saver.del(ctx.agentId, name)
      return { text: `笔记已删除：${name}.md（目录随下次做梦刷新）` }
    },
  }

  return [setLtm, setStm, addNote, delNote]
}
