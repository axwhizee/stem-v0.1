// ============================================================
// core/config/parse.ts —— 配置解析（JSONC → StemConfig）
//
// 零平台依赖：接收文本返回配置对象，文件读写由宿主注入
// （core 不直接碰 fs）。
// ============================================================

import { parse as parseJsonc } from 'jsonc-parser'
import type { ParseError } from 'jsonc-parser'
import type { ToolAccess } from '../tools'
import type { ConfigError, StemConfig, StemContextConfig, StemUserClass } from './types'

/** 合法工具访问动作（四态）。 */
const ACTIONS: readonly ToolAccess[] = ['allow', 'deny', 'ask', 'ignore']

/**
 * 解析 JSONC 文本为配置。
 * 允许注释与尾逗号；语法错误抛 ConfigError。
 */
export function parseConfigText(text: string, file?: string): StemConfig {
  const errors: ParseError[] = []
  let raw: unknown
  try {
    raw = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false })
  } catch (cause) {
    throw configError({
      kind: 'config_parse_error',
      message: cause instanceof Error ? cause.message : String(cause),
      file,
    })
  }
  if (errors.length > 0) {
    throw configError({
      kind: 'config_parse_error',
      message: `JSON 语法错误（错误码 ${errors[0]?.error}）`,
      file,
    })
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw configError({ kind: 'invalid_config', message: '配置必须是 JSON 对象' })
  }
  return normalizeConfig(raw as Record<string, unknown>)
}

/**
 * 归一化任意原始配置：丢弃未知字段、校验已知字段类型。
 * 容错优先：字段类型错误时抛错（配置是唯一载体，坏配置应尽早暴露）。
 */
export function normalizeConfig(raw: Record<string, unknown>): StemConfig {
  const fail = (message: string): never => {
    throw configError({ kind: 'invalid_config', message })
  }

  const model = validateModel(raw.model, fail)
  const autoApprove = validateBoolean(raw.autoApprove, fail, 'autoApprove')
  const sendCountdown = validateNumber(raw.sendCountdown, fail, 'sendCountdown')
  const maxSteps = validateNumber(raw.maxSteps, fail, 'maxSteps')
  const user = raw.user !== undefined ? validateUser(raw.user, fail) : undefined
  const context = raw.context !== undefined ? validateContext(raw.context, fail) : undefined
  const tools = raw.tools !== undefined ? normalizeTools(raw.tools, fail) : undefined
  const agents = raw.agents !== undefined ? normalizeAgents(raw.agents, fail) : undefined
  const strategies = raw.strategies !== undefined ? normalizeStrategies(raw.strategies, fail) : undefined
  const custom =
    raw.custom !== undefined && raw.custom !== null && typeof raw.custom === 'object'
      ? (raw.custom as Readonly<Record<string, unknown>>)
      : undefined

  return {
    ...(model !== undefined ? { model } : {}),
    ...(autoApprove !== undefined ? { autoApprove } : {}),
    ...(sendCountdown !== undefined ? { sendCountdown } : {}),
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    ...(user !== undefined ? { user } : {}),
    ...(context !== undefined ? { context } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(agents !== undefined ? { agents } : {}),
    ...(strategies !== undefined ? { strategies } : {}),
    ...(custom !== undefined ? { custom } : {}),
  }
}

function validateModel(value: unknown, fail: (message: string) => never): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.includes('/')) {
    fail('model 必须是 "提供商/模型" 格式的字符串')
  }
  return value
}

function validateBoolean(value: unknown, fail: (message: string) => never, name: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') fail(`${name} 必须是布尔值`)
  return value
}

function validateNumber(
  value: unknown,
  fail: (message: string) => never,
  name: string,
  upperBound?: number,
): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`${name} 必须是非负数字`)
  }
  if (upperBound !== undefined && value > upperBound) fail(`${name} 不得超过 ${String(upperBound)}`)
  return value
}

/** 工具权限记录（键 → 四态动作）。 */
function validatePermissionRecord(
  value: unknown,
  fail: (message: string) => never,
  path: string,
): Readonly<Record<string, ToolAccess>> | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path} 必须是对象`)
  }
  const permission: Record<string, ToolAccess> = {}
  for (const [tool, action] of Object.entries(value as Record<string, unknown>)) {
    if (!ACTIONS.includes(action as ToolAccess)) fail(`${path}.${tool} 非法（允许 allow/ask/deny/ignore）`)
    permission[tool] = action as ToolAccess
  }
  return permission
}

/** `提供商/模型` 字符串 → ModelRef（config 内部完成，下游零解析）。 */
function validateModelRef(value: unknown, fail: (message: string) => never, path: string) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.includes('/')) {
    fail(`${path} 必须是 "提供商/模型" 格式的字符串`)
  }
  const slash = (value as string).indexOf('/')
  return { provider: (value as string).slice(0, slash), id: (value as string).slice(slash + 1) }
}

/** user0 内嵌 agent 类对象（完整可配）。 */
function validateUser(value: unknown, fail: (message: string) => never): StemUserClass | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('user 必须是对象（user0 内嵌 agent 类配置）')
  }
  const raw = value as Record<string, unknown>
  if (raw.description !== undefined && typeof raw.description !== 'string') fail('user.description 必须是字符串')
  if (raw.systemPrompt !== undefined && typeof raw.systemPrompt !== 'string') fail('user.systemPrompt 必须是字符串')
  if (raw.contextStrategy !== undefined && typeof raw.contextStrategy !== 'string') fail('user.contextStrategy 必须是字符串')
  return {
    ...(raw.description !== undefined ? { description: raw.description as string } : {}),
    ...(raw.systemPrompt !== undefined ? { systemPrompt: raw.systemPrompt as string } : {}),
    ...(raw.permission !== undefined ? { permission: validatePermissionRecord(raw.permission, fail, 'user.permission') } : {}),
    ...(raw.contextStrategy !== undefined ? { contextStrategy: raw.contextStrategy as string } : {}),
    ...(raw.model !== undefined ? { model: validateModelRef(raw.model, fail, 'user.model') } : {}),
    ...(raw.sendCountdown !== undefined ? { sendCountdown: validateNumber(raw.sendCountdown, fail, 'user.sendCountdown') } : {}),
  }
}

/** 上下文策略配置块（window/compact）。 */
function validateContext(value: unknown, fail: (message: string) => never): StemContextConfig | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('context 必须是对象')
  }
  const raw = value as Record<string, unknown>
  const window = validateNumber(raw.window, fail, 'context.window')
  let compact: StemContextConfig['compact'] | undefined
  if (raw.compact !== undefined) {
    if (raw.compact === null || typeof raw.compact !== 'object' || Array.isArray(raw.compact)) {
      fail('context.compact 必须是对象')
    }
    const c = raw.compact as Record<string, unknown>
    if (c.enabled !== undefined && typeof c.enabled !== 'boolean') fail('context.compact.enabled 必须是布尔')
    if (c.instruction !== undefined && typeof c.instruction !== 'string') fail('context.compact.instruction 必须是字符串')
    compact = {
      ...(c.enabled !== undefined ? { enabled: c.enabled as boolean } : {}),
      ...(c.threshold !== undefined ? { threshold: validateNumber(c.threshold, fail, 'context.compact.threshold', 1) } : {}),
      ...(c.keepRecentTurns !== undefined ? { keepRecentTurns: validateNumber(c.keepRecentTurns, fail, 'context.compact.keepRecentTurns') } : {}),
      ...(c.summarizeModel !== undefined ? { summarizeModel: validateModelRef(c.summarizeModel, fail, 'context.compact.summarizeModel') } : {}),
      ...(c.instruction !== undefined ? { instruction: c.instruction as string } : {}),
      ...(c.replyTimeoutMs !== undefined ? { replyTimeoutMs: validateNumber(c.replyTimeoutMs, fail, 'context.compact.replyTimeoutMs') } : {}),
    }
  }
  return {
    ...(window !== undefined ? { window } : {}),
    ...(compact !== undefined ? { compact } : {}),
  }
}

function normalizeTools(raw: unknown, fail: (message: string) => never): StemConfig['tools'] {
  if (!Array.isArray(raw)) fail('tools 必须是数组')
  return raw.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      fail(`tools[${index}] 必须是对象`)
    }
    const entry = item as Record<string, unknown>
    if (typeof entry.id !== 'string') fail(`tools[${index}].id 必须是字符串`)
    if (typeof entry.file !== 'string') fail(`tools[${index}].file 必须是字符串`)
    return {
      id: entry.id,
      file: entry.file,
      kind: entry.kind === 'user' ? 'user' : 'user',
      enabled: entry.enabled === false ? false : true,
    }
  })
}

function normalizeAgents(raw: unknown, fail: (message: string) => never): StemConfig['agents'] {
  if (!Array.isArray(raw)) fail('agents 必须是数组')
  return raw.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      fail(`agents[${index}] 必须是对象`)
    }
    const entry = item as Record<string, unknown>
    if (typeof entry.id !== 'string') fail(`agents[${index}].id 必须是字符串`)
    if (typeof entry.file !== 'string') fail(`agents[${index}].file 必须是字符串`)
    return { id: entry.id, file: entry.file }
  })
}

function normalizeStrategies(raw: unknown, fail: (message: string) => never): StemConfig['strategies'] {
  if (!Array.isArray(raw)) fail('strategies 必须是数组')
  return raw.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      fail(`strategies[${index}] 必须是对象`)
    }
    const entry = item as Record<string, unknown>
    if (typeof entry.id !== 'string') fail(`strategies[${index}].id 必须是字符串`)
    if (typeof entry.file !== 'string') fail(`strategies[${index}].file 必须是字符串`)
    return { id: entry.id, file: entry.file }
  })
}

/** 从配置读取模型引用（`提供商/模型` → { provider, id }）。 */
export function parseModelRef(model: string | undefined, fallback: { provider: string; id: string }): { provider: string; id: string } {
  if (!model) return fallback
  const slash = model.indexOf('/')
  if (slash <= 0 || slash === model.length - 1) return fallback
  return { provider: model.slice(0, slash), id: model.slice(slash + 1) }
}

function configError(e: ConfigError): ConfigError {
  return e
}
