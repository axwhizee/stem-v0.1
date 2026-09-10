// ============================================================
// core/tools/bash.ts —— bash 工具（internal · 最小系统对外操作面）
//
// 设计定位（S4.1 决议）：不采用扩展时，除系统工具外模型操作外部
//   文件/系统的**唯一入口**。执行是平台能力 → core 只定义工具与
//   `ShellRunner` 端口，实现由宿主注入（node child_process）。
//
// 治理哲学（对齐 pi）：**bash 不走 ask、不设黑名单**——高频工具
//   被询问打断模型循环得不偿失。约束全部走机制与分担：
//   - 事故半径：硬超时（缺省可配）、输出截断、cwd 缺省（宿主项目根）；
//   - 行为规范：工具描述提示词（非交互式、专职工具优先）；
//   - 不配 shell 的 agent：模板白名单不列 `bash` 键即可（键即自我限定）。
//
// 错误约定：非零退出码**不是**工具失败（输出+exit code 照常返回，
//   模型自判）；仅 runner 基础设施异常（spawn 失败）抛出，由
//   registry 兜底 execution_failed。
// ============================================================

import { isAbsolute, resolve as resolvePath } from 'node:path'
import type { ToolCapability, ToolResult } from '../types'

// ---------- ShellRunner 端口（宿主注入） ----------

/** 一次 shell 执行请求（core → host）。 */
export interface ShellRunOptions {
  readonly command: string
  /** 工作目录（已按 参数 > config.bash.cwd > 宿主缺省 解析）。 */
  readonly cwd?: string
  /** 硬超时毫秒（已解析；runner 到期必须杀进程并置 timedOut）。 */
  readonly timeoutMs: number
  /** shell 二进制（config.bash.path；缺省由宿主定，典型 'bash'）。 */
  readonly shell?: string
}

/** 一次 shell 执行结果。 */
export interface ShellRunResult {
  readonly stdout: string
  readonly stderr: string
  /** 退出码；null = 被信号终止（含超时强杀）。 */
  readonly exitCode: number | null
  readonly timedOut: boolean
}

/** shell 执行端口：core 不认识 child_process，一切执行经本接口。 */
export interface ShellRunner {
  readonly run: (options: ShellRunOptions) => Promise<ShellRunResult>
}

// ---------- 工具配置（core 缺省 + config.bash 覆盖） ----------

export interface BashToolSettings {
  /** shell 二进制路径（透传给 runner）。 */
  readonly path?: string
  /** 缺省硬超时毫秒。 */
  readonly defaultTimeoutMs?: number
  /** stdout/stderr 各自的截断上限（字符）。 */
  readonly maxOutputChars?: number
  /** 缺省工作目录（参数未给 cwd 时使用；相对路径由宿主解释）。 */
  readonly cwd?: string
}

/** bash 工具内置缺省（config.bash 逐项覆盖）。 */
export const BASH_DEFAULTS = {
  defaultTimeoutMs: 120_000,
  maxOutputChars: 50_000,
} as const

/** 工具入参形状（LLM 侧）。 */
interface BashInput {
  readonly command?: unknown
  readonly cwd?: unknown
  readonly timeoutMs?: unknown
}

// ---------- 工具工厂 ----------

export function createBashTool(deps: {
  runner: ShellRunner
  settings?: BashToolSettings
}): ToolCapability {
  const timeoutMs = deps.settings?.defaultTimeoutMs ?? BASH_DEFAULTS.defaultTimeoutMs
  const maxOutputChars = deps.settings?.maxOutputChars ?? BASH_DEFAULTS.maxOutputChars
  const cwd = deps.settings?.cwd
  const shellPath = deps.settings?.path

  return {
    id: 'bash',
    description:
      '通过 bash 执行 shell 命令（非交互式），返回 stdout / stderr / 退出码。' +
      '命令默认在项目根目录运行，可用 cwd 指定子目录（禁止越出工作区之外）。' +
      '长时间运行的命令请自带超时或改为后台并立即退出，单次执行受 timeoutMs 硬限。' +
      '读取/编辑文件、搜索内容等操作若可用有专用工具（read/grep/glob/edit 等）请优先用它们，bash 留给专用工具覆盖不到的系统操作。' +
      '退出码非零不算执行失败——请根据输出与退出码自行判断后续动作，高危操作（删除、覆盖、网络副作用）三思而后行。',
    accessKey: 'bash',
    kind: 'internal',
    birth: 'allow', // 出生声明：对外操作面（用户裁决：高频工具不走 ask，治理靠超时/截断/cwd 三机制）
    category: 'shell',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令（bash 语法）' },
        cwd: { type: 'string', description: '工作目录（可选，相对项目根或绝对路径；缺省 = 配置缺省目录）' },
        timeoutMs: { type: 'number', description: `本次执行硬超时毫秒（可选，缺省 ${String(timeoutMs)}）` },
      },
      required: ['command'],
    },
    validate: (input) => {
      const args = (input ?? {}) as BashInput
      if (typeof args.command !== 'string' || args.command.trim() === '') return 'command 必须是非空字符串'
      if (args.timeoutMs !== undefined && (typeof args.timeoutMs !== 'number' || args.timeoutMs <= 0)) {
        return 'timeoutMs 必须是正数'
      }
      if (args.cwd !== undefined && typeof args.cwd !== 'string') return 'cwd 必须是字符串'
      return undefined
    },
    execute: async (input, ctx): Promise<ToolResult> => {
      const args = (input ?? {}) as BashInput
      const command = String(args.command)
      // 相对参数以 settings.cwd（宿主接线 = 空间根）为基准解析——不依赖
      // 宿主进程 cwd（验收现场 bug：cwd="." 曾解析到 webui 启动目录）。
      const rawCwd = typeof args.cwd === 'string' && args.cwd !== '' ? args.cwd : cwd
      const effectiveCwd =
        rawCwd !== undefined && cwd !== undefined && !isAbsolute(rawCwd) ? resolvePath(cwd, rawCwd) : rawCwd
      const effectiveTimeout = typeof args.timeoutMs === 'number' ? args.timeoutMs : timeoutMs
      const result = await deps.runner.run({
        command,
        ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
        timeoutMs: effectiveTimeout,
        ...(shellPath !== undefined ? { shell: shellPath } : {}),
      })
      return { text: formatShellOutput(result, { maxOutputChars, timeoutMs: effectiveTimeout }), metadata: { exitCode: result.exitCode, timedOut: result.timedOut, agentId: ctx.agentId } }
    },
  }
}

// ---------- 输出成形（截断 + 尾注） ----------

export function formatShellOutput(
  result: ShellRunResult,
  opts: { maxOutputChars: number; timeoutMs: number },
): string {
  const sections: string[] = []
  const out = clip(result.stdout, opts.maxOutputChars)
  const err = clip(result.stderr, opts.maxOutputChars)
  if (out.text !== '') sections.push(out.text)
  if (err.text !== '') sections.push(`[stderr]\n${err.text}`)
  const notes: string[] = []
  if (out.truncated) notes.push(`stdout 已截断（上限 ${String(opts.maxOutputChars)} 字符）`)
  if (err.truncated) notes.push(`stderr 已截断（上限 ${String(opts.maxOutputChars)} 字符）`)
  if (result.timedOut) notes.push(`执行超时（${String(opts.timeoutMs)}ms），进程已被终止`)
  else if (result.exitCode !== 0) notes.push(`exit code: ${String(result.exitCode)}`)
  const body = sections.join('\n')
  const tail = notes.length > 0 ? `\n[${notes.join(' | ')}]` : ''
  return body + tail
}

/** 头部截断（保留前段 + 省略标记——shell 输出通常前段更有信息量）。 */
function clip(text: string, cap: number): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false }
  return { text: `${text.slice(0, cap)}\n…（后续 ${String(text.length - cap)} 字符已省略）`, truncated: true }
}
