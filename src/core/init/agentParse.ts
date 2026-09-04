// ============================================================
// core/init/agentParse.ts —— 用户 agent 文件解析（.md + YAML 头）
//
// 文件形式（**自由式 frontmatter**——对齐主流 harness 惯例：仅文件名即
// 类名这一格式约束，字段可扩展）：
//   ---
//   description: ...           # 可选（缺省 = 文件名）
//   permission:                # 融合的工具清单（工具=键、动作=值，键即白名单）
//     read: allow
//     edit: ask
//     bash: deny
//   send_countdown: 1000       # 可选送信倒计时
//   max_steps: 12                # 可选单轮工具步数上限（≤0/缺省 = 无限制）
//   context_strategy: classic  # 可选上下文管理策略（strategies 注册表校验）
//   model: provider/id         # 可选模型偏好
//   <任意其它字段>             # 透传进 AgentClass.custom（自定义扩展位）
//   ---
//   <system_prompt 正文>
//
// 设计要点：
//   - **不要求 id/name**：文件名即 agent 类 id 与 name（实例化时才命名）。
//   - **工具与权限融合**：`tools` 的键即工具白名单，避免
//     "有权限无工具 / 有工具无权限" 的尴尬；白名单为本地封闭（键即白名单），
//     祖先显式 deny/ask 仍取严（见 lineage/AccessLedger）。
//   - **未知字段不丢弃**：全部透传 custom——用户模板与内置类配置面齐平，
//     也是 agent 类自我进化的可承载扩展位。
// ============================================================

import { parse as parseYaml } from 'yaml'
import type { ModelRef } from '../gateway'
import type { ToolAccess } from '../tools'

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
  /** 工具白名单（= permission 的键，缺省空）。 */
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

/** 已知键（其余透传 custom）。 */
const KNOWN_KEYS: ReadonlySet<string> = new Set(['description', 'tools', 'send_countdown', 'context_strategy', 'model'])

/** 归一化 YAML 头为 AgentFrontmatter（校验字段类型；未知键收进 extra）。 */
export function normalizeHead(raw: Record<string, unknown>, fail: (message: string) => never): AgentFrontmatter {
  if (raw.description !== undefined && typeof raw.description !== 'string') fail('description 必须是字符串')
  if (
    raw.send_countdown !== undefined &&
    (typeof raw.send_countdown !== 'number' || raw.send_countdown < 0)
  ) {
    fail('send_countdown 必须是非负数字（毫秒）')
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
    if (!KNOWN_KEYS.has(key)) extra[key] = value
  }

  return {
    ...(raw.description !== undefined ? { description: raw.description as string } : {}),
    ...(raw.tools !== undefined
      ? { tools: raw.tools as Readonly<Record<string, string>> }
      : {}),
    ...(raw.send_countdown !== undefined ? { send_countdown: raw.send_countdown as number } : {}),
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
