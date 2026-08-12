// ============================================================
// core/init/agentParse.ts —— 用户 agent 文件解析（.md + YAML 头）
//
// 文件形式（对齐 opencode agent 惯例，但忽略 metadata 等附加字段）：
//   ---
//   description: ...        # 可选（缺省 = 文件名）
//   permission:             # 融合的工具列表 + 权限（工具=权限的键）
//     read: allow
//     edit: ask
//     bash: deny
//   send_countdown: 1000    # 可选送信倒计时
//   ---
//   <system_prompt 正文>
//
// 设计要点：
//   - **不要求 id/name**：文件名即 agent 类 id 与 name（实例化时才命名）。
//   - **工具与权限融合**：`permission` 的键即工具白名单，避免
//     "有权限无工具 / 有工具无权限" 的尴尬；与全局配置中 permission
//     的形态一致（全局低于 agent，见 core/config）。
// ============================================================

import { parse as parseYaml } from 'yaml'
import type { PermissionAction } from '../permission'

/** YAML 头（已归一化；未知字段如 metadata 忽略）。 */
export interface AgentFrontmatter {
  readonly description?: string
  /** 融合的工具权限：工具名 → allow|deny|ask（键即工具白名单）。 */
  readonly permission?: Readonly<Record<string, string>>
  readonly send_countdown?: number
}

/** agent 文件解析结果。 */
export interface ParsedAgentFile {
  /** agent 类 id（= 文件名）。 */
  readonly id: string
  /** agent 类 name（= 文件名）。 */
  readonly name: string
  readonly description: string
  /** 融合的权限（工具 → 动作）。 */
  readonly permissions: Readonly<Record<string, PermissionAction>>
  /** 工具白名单（= permission 的键，缺省空）。 */
  readonly tools: readonly string[]
  readonly sendCountdown?: number
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
  const permissions = normalizePermissions(head.permission, fail)
  // 融合：工具白名单 = permission 的键（缺省无工具）。
  const tools = Object.keys(permissions)
  const systemPrompt = extractPrompt(text)

  return {
    id,
    name,
    description,
    permissions,
    tools,
    ...(head.send_countdown !== undefined ? { sendCountdown: head.send_countdown } : {}),
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

/** 归一化 YAML 头为 AgentFrontmatter（校验字段类型）。 */
export function normalizeHead(raw: Record<string, unknown>, fail: (message: string) => never): AgentFrontmatter {
  if (raw.description !== undefined && typeof raw.description !== 'string') fail('description 必须是字符串')
  if (
    raw.send_countdown !== undefined &&
    (typeof raw.send_countdown !== 'number' || raw.send_countdown < 0)
  ) {
    fail('send_countdown 必须是非负数字（毫秒）')
  }
  if (raw.permission !== undefined) {
    if (raw.permission === null || typeof raw.permission !== 'object' || Array.isArray(raw.permission)) {
      fail('permission 必须是对象')
    }
  }

  return {
    ...(raw.description !== undefined ? { description: raw.description as string } : {}),
    ...(raw.permission !== undefined
      ? { permission: raw.permission as Readonly<Record<string, string>> }
      : {}),
    ...(raw.send_countdown !== undefined ? { send_countdown: raw.send_countdown as number } : {}),
  }
}

/** 提取 `---` 之后的正文（trim）。 */
export function extractPrompt(text: string): string {
  const match = /^---\r?\n[\s\S]*?(?:\r?\n)?---(?:\r?\n|$)([\s\S]*)$/.exec(text)
  return (match?.[1] ?? '').trim()
}

const ACTIONS: readonly string[] = ['allow', 'deny', 'ask']

function normalizePermissions(
  raw: Readonly<Record<string, string>> | undefined,
  fail: (message: string) => never,
): Readonly<Record<string, PermissionAction>> {
  const result: Record<string, PermissionAction> = {}
  for (const [tool, action] of Object.entries(raw ?? {})) {
    if (!ACTIONS.includes(action)) fail(`permission.${tool} 非法（允许 allow/deny/ask）`)
    result[tool] = action as PermissionAction
  }
  return result
}
