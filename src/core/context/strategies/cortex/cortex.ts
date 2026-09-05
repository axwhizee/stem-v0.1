// ============================================================
// core/context/strategies/cortex/cortex.ts —— cortex 策略本体
//
// "上下文是专注度资源"（plan R2）：醒着的你 = 三件套 + 新信（小水位），
// 睡着的你 = 全景重放（大窗随便看）。记忆组/锚点都是仓库真实行
// （write-through 天然跨重启），组装恒为直出——教学样板在"写入"完成。
// 触发链：user_prompt 抵达 → process：①目录再生（diff 才改写 note 行）
// ②估算过 dreamAt 线且全局无梦 → 后台点火 runDream（绝不等它——
// 本轮送信照常，新组下拍生效）。手动链：actions.dream（context_apply
// 模型侧 / pilot / CLI /dream 用户侧，同步等收口拿回报）。
// 配置：类 custom.cortex = {dreamAt?, consolidateModel?}（仅此两件）。
// ============================================================

import { classicAssemble } from '../classic'
import type { StrategyAgentSpec, StrategyApi, StrategyInitContext, StrategyInitFs } from '../types'
import type { AgentClass } from '../../../kernel/types'
import { makeAgentClassID } from '../../../kernel/types'
import type { ContextStrategyModule } from '../types'
import type { ModelRef } from '../../../gateway'
import { CortexRuntime } from './state'
import { createCortexTools } from './tools'
import { MEM_DIR_NAME, refreshTocRow } from './memory'
import { DEFAULT_DREAM_AT, parseCortexSettings } from './schema'
import type { CortexSettings } from './schema'
import { runDream } from './dream'
import type { DreamDeps } from './dream'

/** cortex 扮演 agent（做梦 worker 的父与回信收集点；面板态）。
 *  tools 刻意**不设**（≠ classic 的 {}）：空表 = 本地封闭且显式锁子孙，
 *  会把 worker grant 表里的 cortex_set_* 全锁死；不设 = 匿名不封顶。 */
export const CORTEX_ROLE: AgentClass = {
  name: makeAgentClassID('strategy-cortex'),
  description: 'cortex 策略扮演 agent：做梦 worker 的父与回信收集点（审计信箱，模块扮演，无 LLM 轮）',
  systemPrompt:
    '（模块扮演面板）cortex 上下文策略的执行体：接收做梦 worker 的回信并留档审计；不参与 LLM 组装。',
  sendCountdown: 0,
  panel: true,
  contextStrategy: 'none',
}

export function createCortexStrategy(): ContextStrategyModule {
  const runtime = new CortexRuntime()
  let fsRef: StrategyInitFs | undefined
  let projectRoot = '.'

  const memDirOf = (agentId: string): string => `${projectRoot}/${MEM_DIR_NAME}/${agentId}`

  const settingsFor = (api: StrategyApi): CortexSettings =>
    parseCortexSettings(api.custom, api.settings.window, (message) => {
      const st = runtime.host(api.agentId)
      if (!st.warned.has(message)) {
        st.warned.add(message)
        api.log({ type: 'context.dreamed', agentId: api.agentId, consolidated: false, invalidRows: 0, notesTouched: 0, message: `配置 ${message}` })
      }
    })

  const dreamDeps = (): DreamDeps => ({
    runtime,
    fsRef: () => fsRef,
    projectRoot,
    memDirOf,
  })

  const noteSaver = {
    add: async (agentId: string, name: string, content: string): Promise<void> => {
      if (fsRef?.writeText === undefined || fsRef.ensureDir === undefined) {
        throw { kind: 'cortex_fs_readonly', message: '空间文件系统只读，笔记无法落盘' }
      }
      await fsRef.ensureDir(memDirOf(agentId))
      await fsRef.writeText(`${memDirOf(agentId)}/${name}.md`, content)
    },
    del: async (agentId: string, name: string): Promise<void> => {
      if (fsRef?.writeText === undefined || fsRef.ensureDir === undefined) {
        throw { kind: 'cortex_fs_readonly', message: '空间文件系统只读，笔记无法删除' }
      }
      await fsRef.ensureDir(memDirOf(agentId))
      await fsRef.writeText(`${memDirOf(agentId)}/${name}.md`, '') // 墓碑删除（无 remove 端口）
    },
  }

  return {
    name: 'cortex',
    note:
      '<stem_context>你的上下文策略为 cortex：三层外挂记忆（长期/笔记/短期）+ 做梦固化。' +
      '上下文接近专注线时系统自动"做梦"——整理对话为记忆并归档旧轮（原始消息保留可查）。' +
      '随时可用 cortex_add_note 沉淀主题笔记、context_remove 裁用完的对话轮、' +
      'context_apply(action="dream") 提前做梦；记忆载入示范与操作细则见上下文头部注入。</stem_context>',
    role: CORTEX_ROLE,
    // 记忆组是真实行 → 组装恒直出（教学样板在写入端完成，读取端零特殊）。
    assemble: classicAssemble,
    init: async (ctx: StrategyInitContext): Promise<void> => {
      fsRef = ctx.fs
      projectRoot = ctx.projectRoot
      for (const tool of createCortexTools(runtime, noteSaver)) {
        await ctx.registerTool(tool)
      }
      if (ctx.fs.ensureDir !== undefined) {
        try {
          await ctx.fs.ensureDir(`${ctx.projectRoot}/${MEM_DIR_NAME}`)
        } catch {
          // 目录建不成 = 只读降级（dream 收口自然跳过落盘，warn 一次在那头）。
        }
      }
      // 全局参数预检（类级 dreamAt 在 process 逐宿主校验——这里只核缺省档）。
      parseCortexSettings({ cortex: { dreamAt: DEFAULT_DREAM_AT } }, ctx.settings.window, (message) =>
        ctx.log.log({ type: 'context.dreamed', at: Date.now(), agentId: '*', consolidated: false, invalidRows: 0, notesTouched: 0, message }),
      )
    },
    process: async (api: StrategyApi): Promise<void> => {
      // ① 目录再生（笔记文件真变化才改写 note 行——防语料 churn）。
      if (fsRef !== undefined && api.updateMessage !== undefined) {
        try {
          await refreshTocRow(api, fsRef, memDirOf(api.agentId))
        } catch {
          // 目录再生失败不拦送信（下拍自愈）。
        }
      }
      // ② 阈值点火：过线且全局无梦 → 后台做梦（本轮送信照常，不等收口）。
      if (runtime.dream !== undefined) return
      const settings = settingsFor(api)
      if (api.estimatedTokens() < settings.dreamAt) return
      void runDream(api, settings, dreamDeps())
        .then((outcome) => {
          api.log({
            type: 'context.dreamed',
            agentId: api.agentId,
            consolidated: outcome.consolidated,
            invalidRows: outcome.invalidRows,
            notesTouched: outcome.notesTouched,
            message: outcome.message,
          })
        })
        .catch((cause: unknown) => {
          // 绝不黑吞：点火链异常也进 dreamed 账（半途语义=不轮替，下拍重触发）。
          api.log({
            type: 'context.dreamed',
            agentId: api.agentId,
            consolidated: false,
            invalidRows: 0,
            notesTouched: 0,
            message: `做梦链异常（${cause instanceof Error ? cause.message : JSON.stringify(cause)}）`,
          })
        })
    },
    actions: {
      /** 提前做梦（手动：模型经 context_apply / 用户经 pilot / CLI /dream）。 */
      dream: async (api: StrategyApi): Promise<string> => {
        if (runtime.dream !== undefined) return '已有梦在途（全局串行），稍后再试'
        const outcome = await runDream(api, settingsFor(api), dreamDeps())
        api.log({
          type: 'context.dreamed',
          agentId: api.agentId,
          consolidated: outcome.consolidated,
          invalidRows: outcome.invalidRows,
          notesTouched: outcome.notesTouched,
          message: `手动 ${outcome.message}`,
        })
        return outcome.message
      },
    },
  }
}

export type { CortexSettings }
export type { ModelRef }
