// ============================================================
// core/config/agentFile.ts —— `.stem/agent/<name>.md` 用户文件契约
//
// 用户主权文件（类模板）的解析与序列化同源：parseAgentFile（读）×
// serializeAgentClass（写，agentParse 的逆函数）。**用户文件契约与配置同源**，
// 故随 config 模块（而非装载管线）——装载管线只负责 IO 与注册。
//
// 文件形式（自由式 frontmatter：仅文件名即类名这一格式约束）：
//   ---
//   description: ...           # 可选（缺省 = 文件名）
//   tools:                     # 融合的工具清单（工具=键、动作=值，键即白名单）
//   send_countdown: 1000       # 可选送信倒计时
//   context_strategy: classic  # 可选上下文管理策略
//   model: provider/id         # 可选模型偏好
//   temperature: 0.2           # 可选采样温度
//   effort: high               # 可选思考强度
//   ---
//   <system_prompt 正文>
//
// 未知 frontmatter 字段拒收（custom 槽已退役）；类名即文件名：字符集守卫。
// ============================================================

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { ModelRef } from '../gateway'
import type { ToolAccess } from '../tools'
import type { AgentClass } from '../kernel'
import {
  AGENT_KNOWN_KEYS,
  frontmatterKeyOf,
  normalizeAgentFields,
  pickAgentClassGenes,
} from '../kernel'

// ---------- 解析（读侧） ----------

/** agent 文件解析结果（基因字段经 kernel/attributes 统一归一）。 */
export interface ParsedAgentFile {
  /** agent 类 id（= 文件名）。 */
  readonly id: string
  /** agent 类 name（= 文件名）。 */
  readonly name: string
  readonly description: string
  /** 融合的工具访问（工具 → 动作）。 */
  readonly toolAccess: Readonly<Record<string, ToolAccess>>
  /** 工具白名单（= tools 的键，缺省空）。 */
  readonly tools: readonly string[]
  readonly sendCountdown?: number
  readonly contextStrategy?: string
  readonly model?: ModelRef
  readonly temperature?: number
  readonly effort?: 'none' | 'low' | 'medium' | 'high'
  readonly systemPrompt: string
}

/**
 * 解析 agent .md 文件。
 * @param text 文件全文
 * @param filename 文件名（**即 agent 类 id 与 name**，不读 frontmatter 的 id/name）
 * @returns 解析结果；frontmatter 缺失/非法时抛错（由调用方捕获为 issue）。
 */
export function parseAgentFile(text: string, filename: string): ParsedAgentFile {
  const rawHead = parseFrontmatter(text)
  const fail = (message: string): never => {
    throw new Error(`agent 文件 ${filename} frontmatter 非法：${message}`)
  }

  const genes = normalizeAgentFields(rawHead, { fail, mode: 'frontmatter' })
  const toolAccess = genes.tools ?? {}
  const tools = Object.keys(toolAccess)

  return {
    id: filename,
    name: filename,
    description: genes.description ?? filename,
    toolAccess,
    tools,
    ...(genes.sendCountdown !== undefined ? { sendCountdown: genes.sendCountdown } : {}),
    ...(genes.contextStrategy !== undefined ? { contextStrategy: genes.contextStrategy } : {}),
    ...(genes.model !== undefined ? { model: genes.model } : {}),
    ...(genes.temperature !== undefined ? { temperature: genes.temperature } : {}),
    ...(genes.effort !== undefined ? { effort: genes.effort } : {}),
    systemPrompt: extractPrompt(text),
  }
}

/** 解析 `---` 包裹的 YAML 头；缺 frontmatter 时抛错。 */
export function parseFrontmatter(text: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)(?:\r?\n)?---(?:\r?\n|$)/.exec(text)
  if (!match) throw new Error('缺少 --- 包裹的 YAML frontmatter')
  const yaml = parseYaml(match[1] ?? '')
  // 空 YAML 头 → 空对象。
  if (yaml === null || yaml === undefined) return {}
  if (typeof yaml !== 'object' || Array.isArray(yaml)) {
    throw new Error('YAML frontmatter 必须是对象')
  }
  return yaml as Record<string, unknown>
}

/** frontmatter 已知键（解析与序列化**共用**同一集合，防两侧漂移；其余透传 custom）。 */
export { AGENT_KNOWN_KEYS }

/** 提取 `---` 之后的正文（trim）。 */
export function extractPrompt(text: string): string {
  const match = /^---\r?\n[\s\S]*?(?:\r?\n)?---(?:\r?\n|$)([\s\S]*)$/.exec(text)
  return (match?.[1] ?? '').trim()
}

// ---------- 序列化（写侧；parse 的逆） ----------

/** 类名字符集（= 文件名安全）：字母数字开头，允许字母数字 . _ -。 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 类名 → 落盘文件名（含注入守卫）。 */
export function agentFileName(name: string): string {
  if (!NAME_RE.test(name) || name.includes('..')) {
    throw new Error(`类名不可作为文件名落盘（仅允许字母数字与 . _ -，不得含路径分隔）：${JSON.stringify(name)}`)
  }
  return `${name}.md`
}

/** 目录 + 类名 → 文件路径（core 零平台依赖：不做平台 join，约定 '/' 拼接与 ConfigPaths 同源）。 */
export function agentFileOf(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${agentFileName(name)}`
}

/**
 * AgentClass → `.stem/agent/<name>.md` 全文（frontmatter + 正文）。
 * @throws 系统机制类回写（红线）/ 类名非法。
 */
export function serializeAgentClass(cls: AgentClass): string {
  const genes = pickAgentClassGenes(cls)
  const head: Record<string, unknown> = {
    description: genes.description,
    tools: { ...genes.tools },
  }
  if (genes.sendCountdown !== undefined) head[frontmatterKeyOf('sendCountdown')] = genes.sendCountdown
  if (genes.contextStrategy !== undefined) head[frontmatterKeyOf('contextStrategy')] = genes.contextStrategy
  if (genes.model !== undefined) head[frontmatterKeyOf('model')] = `${genes.model.provider}/${genes.model.id}`
  if (genes.temperature !== undefined) head[frontmatterKeyOf('temperature')] = genes.temperature
  if (genes.effort !== undefined) head[frontmatterKeyOf('effort')] = genes.effort
  const yaml = stringifyYaml(head)
  return `---\n${yaml}---\n\n${cls.systemPrompt}\n`
}
