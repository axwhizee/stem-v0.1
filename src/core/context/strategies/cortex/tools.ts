// ============================================================
// core/context/strategies/cortex/tools.ts —— cortex 工具面（两枚）
//
// 生命周期角色（教学样板的"真名"侧；读侧 cortex_load_* 是组装轮里的
// 虚拟名，不注册——幻觉点名 = unknown 无害）：
//   cortex_add_note / cortex_del_note —— agent 与 dreamer 双可写。
//     权限面：出生 ignore（策略注册通例）+ 策略声明清单（cortex.tools
//     raise allow）——只有启用 cortex 的宿主自动持有，非 cortex 类不再
//     白拿（s11 裁决：策略与类配置矛盾 = 实例化拒绝，复用收敛检查）。
//     归属路由：dreamer 调用（做梦在途且 caller ≠ host）→ 以 **host
//     名义立即落盘** host 目录并计数；宿主自己调用 → 落自己目录。
//   （旧 cortex_set_ltm/set_stm 与全局暂存机制已整体退役——dreamer 的
//   交付物 = 回信（schema.ts parseDreamReport），轮替原子性住 runDream
//   收口段。）
// 权限执行在 kernel 工具链（族谱台账），本模块零鉴权零特权——工具面
// 纯同步，fs 经注入回调（NoteSaver）。
// ============================================================

import type { ToolCapability } from '../../../tools'
import type { CortexRuntime } from './state'
import { validateNoteName } from './schema'

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

/** 笔记归属：dreamer（做梦在途、caller 非 host）→ host 目录；宿主自持 → 自己目录。 */
function ownerOf(runtime: CortexRuntime, callerId: string): string {
  return runtime.isDreamWorker(callerId) && runtime.dream !== undefined ? runtime.dream.hostId : callerId
}

export function createCortexTools(runtime: CortexRuntime, saver: NoteSaver): readonly ToolCapability[] {
  const addNote: ToolCapability = {
    id: 'cortex_add_note',
    kind: 'custom',
    birth: 'ignore', // 策略注册工具出生恒 ignore（上台面走策略声明清单 raise）
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
      const owner = ownerOf(runtime, ctx.agentId)
      await saver.add(owner, name, content)
      if (owner !== ctx.agentId) runtime.touchNote()
      return { text: `笔记已落盘：${name}.md（做梦时自动载入目录；读用 read 工具 ${name}.md 全路径）` }
    },
  }

  const delNote: ToolCapability = {
    id: 'cortex_del_note',
    kind: 'custom',
    birth: 'ignore', // 策略注册工具出生恒 ignore（上台面走策略声明清单 raise）
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
      const owner = ownerOf(runtime, ctx.agentId)
      await saver.del(owner, name)
      if (owner !== ctx.agentId) runtime.touchNote()
      return { text: `笔记已删除：${name}.md（目录随下次做梦刷新）` }
    },
  }

  return [addNote, delNote]
}
