// ============================================================
// core/config/parse.ts —— 配置解析（JSONC → StemConfig）
//
// 零平台依赖：接收文本返回配置对象，文件读写由宿主注入
// （core 不直接碰 fs）。
// ============================================================

import { parse as parseJsonc } from 'jsonc-parser'
import type { ParseError } from 'jsonc-parser'
import type { ModelRef } from '../gateway'
import {
  asModelRef,
  asNonNegNumber,
  asString,
  asToolAccessRecord,
  normalizeAgentFields,
} from '../kernel'
import type { ConfigError, StemBashConfig, StemConfig, StemContextConfig, StemExtensionsConfig, StemProviderConfig, StemToolsConfig, StemUserClass } from './types'

/**
 * config 全量有效原则（S6/R12）：顶层键必须在此表内——config 即全部配置，
 * 每个键都要有明确消费者；未知键 fail-fast（废除 S4.2"静默丢弃"兼容，
 * 自定义扩展位的唯一合法出口 = custom 块）。
 */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'providers',
  'autoApprove',
  'user',
  'context',
  'bash',
  'tools',
  'sendCountdown',
  'extensions',
  'custom',
])

/** 已废除的历史键 → 迁移指路（仍 fail-fast，但错误可行动）。 */
const RETIRED_KEYS: Readonly<Record<string, string>> = {
  model: '顶层 model 已拆除（R12）：user 类 model 基因 = user.model（全体缺省的本体）',
  agents: '目录即真相：类文件放入 .stem/agent/ 即自动注册',
  strategies: '目录即真相：策略文件放入 .stem/context/ 即自动注册',
}

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
 * 归一化任意原始配置：校验已知字段、拒绝未知字段（R12 全量有效原则）。
 * 容错零容忍：坏配置应尽早暴露（boot fail-fast，错误可行动）。
 */
export function normalizeConfig(raw: Record<string, unknown>): StemConfig {
  const fail = (message: string): never => {
    throw configError({ kind: 'invalid_config', message })
  }

  for (const key of Object.keys(raw)) {
    if (KNOWN_KEYS.has(key)) continue
    const hint = RETIRED_KEYS[key]
    fail(
      `未知配置键 "${key}"：${hint ?? 'config 即全部配置，未知键无消费者（自定义扩展请放入 custom 块）'}`,
    )
  }

  const providers = raw.providers !== undefined ? validateProviders(raw.providers, fail) : undefined
  const autoApprove = validateBoolean(raw.autoApprove, fail, 'autoApprove')
  const sendCountdown = validateNumber(raw.sendCountdown, fail, 'sendCountdown')
  const user = raw.user !== undefined ? validateUser(raw.user, fail) : undefined
  const context = raw.context !== undefined ? validateContext(raw.context, fail) : undefined
  const bash = raw.bash !== undefined ? validateBash(raw.bash, fail) : undefined
  const tools = raw.tools !== undefined ? validateTools(raw.tools, fail) : undefined
  const extensions = raw.extensions !== undefined ? validateExtensions(raw.extensions, fail) : undefined
  const custom =
    raw.custom !== undefined && raw.custom !== null && typeof raw.custom === 'object'
      ? (raw.custom as Readonly<Record<string, unknown>>)
      : undefined

  // 交叉校验：config 内部模型引用必须命中 providers 注册表 + 白名单
  // （类文件/工具参数等运行期引用由网关路由侧"用到才硬错"，R1）。
  if (user?.model !== undefined) checkModelAllowed(user.model, providers ?? {}, 'user.model', fail)
  const summarize = context?.compact?.summarizeModel
  if (summarize !== undefined) checkModelAllowed(summarize, providers ?? {}, 'context.compact.summarizeModel', fail)

  return {
    ...(providers !== undefined ? { providers } : {}),
    ...(autoApprove !== undefined ? { autoApprove } : {}),
    ...(sendCountdown !== undefined ? { sendCountdown } : {}),
    ...(user !== undefined ? { user } : {}),
    ...(context !== undefined ? { context } : {}),
    ...(bash !== undefined ? { bash } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(extensions !== undefined ? { extensions } : {}),
    ...(custom !== undefined ? { custom } : {}),
  }
}

/** providers 注册表（R13：base_url 必填 http(s)；key_env 非空变量名；models 非空字符串数组）。 */
function validateProviders(
  value: unknown,
  fail: (message: string) => never,
): Readonly<Record<string, StemProviderConfig>> | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('providers 必须是对象（模型提供商注册表：provider 名 → { base_url, key_env?, models? }）')
  }
  const result: Record<string, StemProviderConfig> = {}
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (name.trim() === '') fail('providers: provider 名不能为空')
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`providers.${name} 必须是对象（{ base_url, key_env?, models? }）`)
    }
    const e = entry as Record<string, unknown>
    for (const key of Object.keys(e)) {
      if (key !== 'base_url' && key !== 'key_env' && key !== 'models') {
        fail(`providers.${name}.${key} 未知键（合法键：base_url / key_env / models）`)
      }
    }
    if (typeof e.base_url !== 'string' || !/^https?:\/\//.test(e.base_url)) {
      fail(`providers.${name}.base_url 必填：OpenAI 兼容端点 URL（http(s):// 开头，实际 POST {base_url}/chat/completions）`)
    }
    if (e.key_env !== undefined && (typeof e.key_env !== 'string' || e.key_env.trim() === '')) {
      fail(`providers.${name}.key_env 必须是非空字符串（环境变量名；缺省 = 匿名/本地端点）`)
    }
    let models: readonly string[] | undefined
    if (e.models !== undefined) {
      if (!Array.isArray(e.models)) fail(`providers.${name}.models 必须是数组（启用白名单；空数组 = 全启用）`)
      models = (e.models as unknown[]).map((m, index) => {
        if (typeof m !== 'string' || m.trim() === '') fail(`providers.${name}.models[${index}] 必须是非空字符串`)
        return m as string
      })
    }
    result[name] = {
      base_url: e.base_url as string,
      ...(e.key_env !== undefined ? { key_env: e.key_env as string } : {}),
      ...(models !== undefined ? { models } : {}),
    }
  }
  return result
}

/** 模型引用 × providers 注册表对拍（provider 必注册；非空白名单必命中）。 */
function checkModelAllowed(
  ref: ModelRef,
  providers: Readonly<Record<string, StemProviderConfig>>,
  path: string,
  fail: (message: string) => never,
): void {
  const provider = providers[ref.provider]
  if (provider === undefined) {
    const registered = Object.keys(providers)
    fail(`${path} "${ref.provider}/${ref.id}"：provider "${ref.provider}" 未在 providers 注册${registered.length > 0 ? `（已注册：${registered.join(', ')}）` : '（providers 缺失或为空）'}`)
  }
  if (provider.models !== undefined && provider.models.length > 0 && !provider.models.includes(ref.id)) {
    fail(`${path} "${ref.provider}/${ref.id}"：模型未启用（providers.${ref.provider}.models 白名单 = ${provider.models.join(', ')}）`)
  }
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
  const n = asNonNegNumber(value, name, fail)
  if (n !== undefined && upperBound !== undefined && n > upperBound) fail(`${name} 不得超过 ${String(upperBound)}`)
  return n
}

/** 根的类配置对象（完整可配；基因字段经 kernel/attributes 统一归一）。 */
function validateUser(value: unknown, fail: (message: string) => never): StemUserClass | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('user 必须是对象（根 user#0 的类配置）')
  }
  const raw = value as Record<string, unknown>
  const systemPrompt = asString(raw.systemPrompt, 'user.systemPrompt', fail)
  const name = asString(raw.name, 'user.name', fail)
  const genes = normalizeAgentFields(raw, {
    fail,
    mode: 'camel',
    pathPrefix: 'user',
    passthrough: new Set(['systemPrompt', 'name']),
  })
  return {
    ...(genes.description !== undefined ? { description: genes.description } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(genes.tools !== undefined ? { tools: genes.tools } : {}),
    ...(genes.contextStrategy !== undefined ? { contextStrategy: genes.contextStrategy } : {}),
    ...(genes.model !== undefined ? { model: genes.model } : {}),
    ...(genes.sendCountdown !== undefined ? { sendCountdown: genes.sendCountdown } : {}),
    ...(genes.temperature !== undefined ? { temperature: genes.temperature } : {}),
    ...(genes.effort !== undefined ? { effort: genes.effort as StemUserClass['effort'] } : {}),
    ...(name !== undefined ? { name } : {}),
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
      ...(c.summarizeModel !== undefined ? { summarizeModel: asModelRef(c.summarizeModel, 'context.compact.summarizeModel', fail) } : {}),
      ...(c.instruction !== undefined ? { instruction: c.instruction as string } : {}),
      ...(c.replyTimeoutMs !== undefined ? { replyTimeoutMs: validateNumber(c.replyTimeoutMs, fail, 'context.compact.replyTimeoutMs') } : {}),
    }
  }
  return {
    ...(window !== undefined ? { window } : {}),
    ...(compact !== undefined ? { compact } : {}),
  }
}

/** bash 工具配置块（path/defaultTimeoutMs/maxOutputChars/cwd）。 */
function validateBash(value: unknown, fail: (message: string) => never): StemBashConfig | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('bash 必须是对象')
  }
  const raw = value as Record<string, unknown>
  if (raw.path !== undefined && typeof raw.path !== 'string') fail('bash.path 必须是字符串')
  if (raw.cwd !== undefined && typeof raw.cwd !== 'string') fail('bash.cwd 必须是字符串')
  return {
    ...(raw.path !== undefined ? { path: raw.path as string } : {}),
    ...(raw.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: validateNumber(raw.defaultTimeoutMs, fail, 'bash.defaultTimeoutMs') } : {}),
    ...(raw.maxOutputChars !== undefined ? { maxOutputChars: validateNumber(raw.maxOutputChars, fail, 'bash.maxOutputChars') } : {}),
    ...(raw.cwd !== undefined ? { cwd: raw.cwd as string } : {}),
  }
}

/**
 * tools 配置块（`{ outputLimit? }`）。历史顶层 `tools` 为工具清单，
 * 现由 user.tools / extensions.tools 承载——数组形态给可行动迁移错误。
 */
function validateTools(value: unknown, fail: (message: string) => never): StemToolsConfig | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value)) {
    fail(
      'config.tools 不再是工具清单数组：现为工具框架配置块（{ outputLimit }）。' +
        '工具访问清单请在 config.user.tools（根收敛）或 config.extensions.tools（装载点名）声明',
    )
  }
  if (value === null || typeof value !== 'object') {
    fail('tools 必须是对象（工具框架配置块 { outputLimit? }）')
  }
  const raw = value as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (key !== 'outputLimit') fail(`tools.${key} 为未知键（合法：outputLimit）`)
  }
  return {
    ...(raw.outputLimit !== undefined ? { outputLimit: validateNumber(raw.outputLimit, fail, 'tools.outputLimit') } : {}),
  }
}

/**
 * extensions：资源点名面——tools = {名: 权限词}（装载与出生一句话；
 * 键在 extension/tools/ 或 .stem/tools/ 解析不到 = boot 硬错，由 init 管线执行）；
 * agent/context = 条目名数组（extension/<键>/ 目录形态）。旧数组形态 fail-fast 指路。
 */
function validateExtensions(value: unknown, fail: (message: string) => never): StemExtensionsConfig | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('extensions 必须是 { tools?, agent?, context? } 对象')
  }
  const raw = value as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (key !== 'tools' && key !== 'agent' && key !== 'context') {
      fail(`extensions.${key} 为未知键（合法：tools / agent / context）`)
    }
  }
  const result: Record<string, unknown> = {}
  if (raw.tools !== undefined) {
    if (Array.isArray(raw.tools)) {
      fail(
        'extensions.tools 数组形态已退役：改为 {名: 权限词} 对象（装载与出生一句话说完），' +
          '如 { "tools": { "read": "allow", "write": "allow" } }',
      )
    }
    result.tools = asToolAccessRecord(raw.tools, 'extensions.tools', fail)
  }
  for (const key of ['agent', 'context'] as const) {
    if (raw[key] === undefined) continue
    const list = raw[key]
    if (!Array.isArray(list)) fail(`extensions.${key} 必须是字符串数组`)
    result[key] = (list as unknown[]).map((item, index) => {
      if (typeof item !== 'string' || item === '') fail(`extensions.${key}[${index}] 必须是非空字符串`)
      return item
    })
  }
  return result as StemExtensionsConfig
}

function configError(e: ConfigError): ConfigError {
  return e
}
