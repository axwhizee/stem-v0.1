// ============================================================
// core/config/agentFile.ts —— `.stem/agent/<name>.md` 用户文件契约
//
// 用户主权文件（类模板）的解析与序列化同源：parseAgentFile（读）×
// serializeAgentClass（写，agentParse 的逆函数）。**用户文件契约与配置同源**，
// 故随 config 模块（而非装载管线）——装载管线只负责 IO 与注册。
//
// 文件形式（自由式 frontmatter：仅文件名即类名这一格式约束，字段可扩展）：
//   ---
//   description: ...           # 可选（缺省 = 文件名）
//   tools:                     # 融合的工具清单（工具=键、动作=值，键即白名单）
//     read: allow
//     bash: deny
//   send_countdown: 1000       # 可选送信倒计时
//   max_steps: 12              # 可选单轮工具步数上限（≤0/缺省 = 无限制）
//   context_strategy: classic  # 可选上下文管理策略
//   model: provider/id         # 可选模型偏好
//   <任意其它字段>             # 透传进 AgentClass.custom（自定义扩展位）
//   ---
//   <system_prompt 正文>
//
// **红线**（D6/D7）：
//   - `panel === true` 的模块扮演类（策略 role 等机制类）**永不回写**
//     ——系统机制类与用户主权基因分界，`.stem/agent/` 只装后者；
//   - 类名即文件名：字符集守卫（拒路径穿越；模型可控输入参与文件路径）。
// ============================================================

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { ModelRef } from '../gateway'
import type { ToolAccess } from '../tools'
import type { AgentClass } from '../kernel'

// ---------- 解析（读侧） ----------

/** YAML 头（已归一化；未知字段透传 custom）。 */
export interface AgentFrontmatter {
  readonly description?: string
  /** 融合的工具访问：工具名 → allow|ask|deny|ignore（键即工具白名单）。 */
  readonly tools?: Readonly<Record<string, string>>
  readonly send_countdown?: number
  /** 单轮工具步数上限（S9；≤0/未设 = 无限制）。 */
  readonly max_steps?: number
  /** 上下文管理策略名（缺省 classic；注册期由策略注册表校验）。 */
  readonly context_strategy?: string
  /** 模型偏好（`提供商/模型`）。 */
  readonly model?: string
  /** 其余未知字段（自定义扩展位）。 */
  readonly extra: Readonly<Record<string, unknown>>
}

/** agent 文件解析结果。 */
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
  readonly maxSteps?: number
  readonly contextStrategy?: string
  readonly model?: ModelRef
  readonly custom: Readonly<Record<string, unknown>>
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

  const head = normalizeHead(rawHead, fail)

  const id = filename
  const name = filename
  const description = head.description ?? name
  const toolAccess = normalizePermissions(head.tools, fail)
  // 融合：工具白名单 = tools 的键（缺省无工具）。
  const tools = Object.keys(toolAccess)
  const systemPrompt = extractPrompt(text)
  const model = head.model !== undefined ? parseModelString(head.model, fail) : undefined

  return {
    id,
    name,
    description,
    toolAccess,
    tools,
    ...(head.send_countdown !== undefined ? { sendCountdown: head.send_countdown } : {}),
    ...(head.max_steps !== undefined ? { maxSteps: head.max_steps } : {}),
    ...(head.context_strategy !== undefined ? { contextStrategy: head.context_strategy } : {}),
    ...(model !== undefined ? { model } : {}),
    custom: head.extra,
    systemPrompt,
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
export const AGENT_KNOWN_KEYS: ReadonlySet<string> = new Set([
  'description',
  'tools',
  'send_countdown',
  'max_steps',
  'context_strategy',
  'model',
])

/** 归一化 YAML 头为 AgentFrontmatter（校验字段类型；未知键收进 extra）。 */
export function normalizeHead(raw: Record<string, unknown>, fail: (message: string) => never): AgentFrontmatter {
  if (raw.description !== undefined && typeof raw.description !== 'string') fail('description 必须是字符串')
  if (
    raw.send_countdown !== undefined &&
    (typeof raw.send_countdown !== 'number' || raw.send_countdown < 0)
  ) {
    fail('send_countdown 必须是非负数字（毫秒）')
  }
  if (raw.max_steps !== undefined && (typeof raw.max_steps !== 'number' || !Number.isFinite(raw.max_steps))) {
    fail('max_steps 必须是数字（≤0/缺省 = 无限制）')
  }
  if (raw.tools !== undefined) {
    if (raw.tools === null || typeof raw.tools !== 'object' || Array.isArray(raw.tools)) {
      fail('tools 必须是对象')
    }
  }
  if (raw.context_strategy !== undefined && typeof raw.context_strategy !== 'string') {
    fail('context_strategy 必须是字符串')
  }
  if (raw.model !== undefined && typeof raw.model !== 'string') fail('model 必须是字符串（提供商/模型）')
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!AGENT_KNOWN_KEYS.has(key)) extra[key] = value
  }

  return {
    ...(raw.description !== undefined ? { description: raw.description as string } : {}),
    ...(raw.tools !== undefined
      ? { tools: raw.tools as Readonly<Record<string, string>> }
      : {}),
    ...(raw.send_countdown !== undefined ? { send_countdown: raw.send_countdown as number } : {}),
    ...(raw.max_steps !== undefined ? { max_steps: raw.max_steps as number } : {}),
    ...(raw.context_strategy !== undefined ? { context_strategy: raw.context_strategy as string } : {}),
    ...(raw.model !== undefined ? { model: raw.model as string } : {}),
    extra,
  }
}

/** `提供商/模型` 字符串 → ModelRef（严格格式，agent 文件写错应尽早暴露）。 */
function parseModelString(value: string, fail: (message: string) => never): ModelRef {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) fail('model 必须是 "提供商/模型" 格式')
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) }
}

/** 提取 `---` 之后的正文（trim）。 */
export function extractPrompt(text: string): string {
  const match = /^---\r?\n[\s\S]*?(?:\r?\n)?---(?:\r?\n|$)([\s\S]*)$/.exec(text)
  return (match?.[1] ?? '').trim()
}

const ACTIONS: readonly string[] = ['allow', 'deny', 'ask', 'ignore']

function normalizePermissions(
  raw: Readonly<Record<string, string>> | undefined,
  fail: (message: string) => never,
): Readonly<Record<string, ToolAccess>> {
  const result: Record<string, ToolAccess> = {}
  for (const [tool, action] of Object.entries(raw ?? {})) {
    if (!ACTIONS.includes(action)) fail(`tools.${tool} 非法（允许 allow/ask/deny/ignore）`)
    result[tool] = action as ToolAccess
  }
  return result
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
 * @throws panel 类回写（红线）/ custom 键与已知键冲突 / 类名非法。
 */
export function serializeAgentClass(cls: AgentClass): string {
  if (cls.panel === true) {
    throw new Error(`panel 类 ${cls.name} 为系统机制承载，永不回写 .stem/agent/（红线）`)
  }
  const head: Record<string, unknown> = {
    description: cls.description,
    tools: { ...cls.tools },
    ...(cls.sendCountdown !== undefined ? { send_countdown: cls.sendCountdown } : {}),
    ...(cls.maxSteps !== undefined ? { max_steps: cls.maxSteps } : {}),
    ...(cls.contextStrategy !== undefined ? { context_strategy: cls.contextStrategy } : {}),
    ...(cls.model !== undefined ? { model: `${cls.model.provider}/${cls.model.id}` } : {}),
  }
  // custom 自由键透传（进化基因承载位）：与已知键冲突 = 歧义，拒绝落盘；undefined 值剔除。
  for (const [key, value] of Object.entries(cls.custom ?? {})) {
    if (AGENT_KNOWN_KEYS.has(key)) {
      throw new Error(`custom 键 "${key}" 与 frontmatter 已知键冲突，无法无损往返（请改用标准字段）`)
    }
    if (value === undefined) continue
    head[key] = value
  }
  const yaml = stringifyYaml(head)
  return `---\n${yaml}---\n\n${cls.systemPrompt}\n`
}
