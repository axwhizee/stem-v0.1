// ============================================================
// core/kernel/attributes.ts —— Agent 类字段单一真相（校验 + 键名映射 + 归一）
//
// 全体类产生通道同形（`.stem/agent/*.md` / `config.user` / 策略 spec /
// `agent_class_*`）；本文件收口字段校验与命名映射，消除五处手工镜像。
// 新增类参数：改 AgentClass 接口 + 本表一处，各通道自动够着。
// ============================================================

import type { EffortLevel, ModelRef } from '../gateway'
import { parseModelRef } from '../gateway'
import type { ToolAccess } from '../tools'

// ---------- 共享校验器 ----------

/** 工具访问四态。 */
const ACCESS_ACTIONS: readonly ToolAccess[] = ['allow', 'deny', 'ask', 'ignore']

/** 非空字符串字段（可选）。 */
export function asString(
  value: unknown,
  path: string,
  fail: (message: string) => never,
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') fail(`${path} 必须是字符串`)
  return value as string
}

/** 非负有限数字字段（可选；倒计时等）。 */
export function asNonNegNumber(
  value: unknown,
  path: string,
  fail: (message: string) => never,
): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`${path} 必须是非负数字`)
  }
  return value as number
}

/** 工具访问记录（键即白名单）。 */
export function asToolAccessRecord(
  value: unknown,
  path: string,
  fail: (message: string) => never,
): Readonly<Record<string, ToolAccess>> | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path} 必须是对象`)
  }
  const result: Record<string, ToolAccess> = {}
  for (const [tool, action] of Object.entries(value as Record<string, unknown>)) {
    if (!ACCESS_ACTIONS.includes(action as ToolAccess)) {
      fail(`${path}.${tool} 非法（允许 allow/ask/deny/ignore）`)
    }
    result[tool] = action as ToolAccess
  }
  return result
}

/** `提供商/模型` 字符串 → ModelRef（两段皆非空；解析走 gateway 单点）。 */
export function parseModelRefString(
  value: string,
  path: string,
  fail: (message: string) => never,
): ModelRef {
  const parsed = parseModelRef(value)
  if (parsed === undefined) {
    fail(`${path} 必须是 "提供商/模型" 格式（收到 "${value}"）`)
  }
  return parsed as ModelRef
}

/** 模型字段：接受 `"提供商/模型"` 字符串或已解析 ModelRef。 */
export function asModelRef(
  value: unknown,
  path: string,
  fail: (message: string) => never,
): ModelRef | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return parseModelRefString(value, path, fail)
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const m = value as { provider?: unknown; id?: unknown }
    if (typeof m.provider === 'string' && m.provider !== '' && typeof m.id === 'string' && m.id !== '') {
      return { provider: m.provider, id: m.id }
    }
  }
  fail(`${path} 必须是 "提供商/模型" 字符串或 {provider,id} 对象`)
}

// ---------- 键名映射（frontmatter snake_case ↔ camelCase） ----------

/** 类可选基因字段（AgentClass 上除 name/systemPrompt 外的可配面）。 */
export interface AgentClassGenes {
  readonly description?: string
  readonly tools?: Readonly<Record<string, ToolAccess>>
  readonly contextStrategy?: string
  readonly model?: ModelRef
  readonly sendCountdown?: number
  readonly temperature?: number
  readonly effort?: EffortLevel
}

/** frontmatter 键 → 规范 camelCase 键。 */
const FRONTMATTER_TO_CAMEL: Readonly<Record<string, keyof AgentClassGenes>> = {
  description: 'description',
  tools: 'tools',
  context_strategy: 'contextStrategy',
  model: 'model',
  send_countdown: 'sendCountdown',
  temperature: 'temperature',
  effort: 'effort',
}

/** frontmatter 已知键集合（解析与序列化共用）。 */
export const AGENT_KNOWN_KEYS: ReadonlySet<string> = new Set(Object.keys(FRONTMATTER_TO_CAMEL))

/** camelCase 键 → frontmatter 键（序列化用）。 */
export function frontmatterKeyOf(camel: keyof AgentClassGenes): string {
  for (const [fm, c] of Object.entries(FRONTMATTER_TO_CAMEL)) {
    if (c === camel) return fm
  }
  return camel
}

// ---------- 统一归一 ----------

export type NormalizeMode =
  /** `.stem/agent` frontmatter：snake_case 键；未知键收进 custom。 */
  | 'frontmatter'
  /** camelCase 入参（config.user / 工具 DTO / 策略 spec）：未知键忽略。 */
  | 'camel'

export interface NormalizeOptions {
  /** 错误路径前缀（如 `user.tools`）。 */
  readonly pathPrefix?: string
  readonly fail: (message: string) => never
  readonly mode: NormalizeMode
  /** 允许的额外键（不参与归一、由调用方自取，如 config.user.name）。 */
  readonly passthrough?: ReadonlySet<string>
}

/**
 * 统一类字段归一：接受 frontmatter 或 camelCase 原始表，产出规范基因字段。
 * 单一校验/映射点——各产生通道不再各自手写字段逻辑。
 * frontmatter 模式错误路径用原 snake_case 键（用户书写面）。
 */
export function normalizeAgentFields(
  raw: Readonly<Record<string, unknown>>,
  options: NormalizeOptions,
): AgentClassGenes {
  const { fail, mode } = options
  const prefix = options.pathPrefix !== undefined ? `${options.pathPrefix}.` : ''
  const passthrough = options.passthrough ?? new Set<string>()

  // 键名归一：frontmatter 模式翻译 snake_case；camel 模式原样。
  const source = new Map<string, { value: unknown; pathKey: string }>()
  for (const [key, value] of Object.entries(raw)) {
    if (passthrough.has(key)) continue
    if (mode === 'frontmatter') {
      const camel = FRONTMATTER_TO_CAMEL[key]
      if (camel !== undefined) source.set(camel, { value, pathKey: key })
      else fail(`未知字段 "${key}"（合法：${[...AGENT_KNOWN_KEYS].join(' / ')}）`)
    } else {
      if (key in FRONTMATTER_TO_CAMEL || isCamelGeneKey(key)) {
        source.set(key, { value, pathKey: key })
      }
      // camel 模式未知键静默忽略（config.user 现行行为；顶层 config 仍严格）
    }
  }

  const at = (camel: keyof AgentClassGenes): string =>
    `${prefix}${source.get(camel)?.pathKey ?? camel}`

  const description = asString(source.get('description')?.value, at('description'), fail)
  const tools = asToolAccessRecord(source.get('tools')?.value, at('tools'), fail)
  const contextStrategy = asString(source.get('contextStrategy')?.value, at('contextStrategy'), fail)
  const model = asModelRef(source.get('model')?.value, at('model'), fail)
  const sendCountdown = asNonNegNumber(source.get('sendCountdown')?.value, at('sendCountdown'), fail)
  const temperature = asNonNegNumber(source.get('temperature')?.value, at('temperature'), fail)
  let effort: EffortLevel | undefined
  const effortRaw = asString(source.get('effort')?.value, at('effort'), fail)
  if (effortRaw !== undefined) {
    if (!['none', 'low', 'medium', 'high'].includes(effortRaw)) {
      fail(`${at('effort')} 必须是 none/low/medium/high 之一`)
    }
    effort = effortRaw as EffortLevel
  }

  return {
    ...(description !== undefined ? { description } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(contextStrategy !== undefined ? { contextStrategy } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(sendCountdown !== undefined ? { sendCountdown } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(effort !== undefined ? { effort } : {}),
  }
}

function isCamelGeneKey(key: string): boolean {
  return CAMEL_GENE_KEYS.has(key)
}

/** camelCase 基因键集合（与 FRONTMATTER_TO_CAMEL 值域同源，防双表漂移）。 */
const CAMEL_GENE_KEYS: ReadonlySet<string> = new Set(Object.values(FRONTMATTER_TO_CAMEL))

/**
 * 从任意类基因来源对象挑出 AgentClass 可选字段（toolHost/loader/builtin 共用）。
 * 仅拷贝已定义字段，保持 optional 形状。
 */
export function pickAgentClassGenes(source: {
  readonly description?: string
  readonly tools?: Readonly<Record<string, ToolAccess>>
  readonly contextStrategy?: string
  readonly model?: ModelRef
  readonly sendCountdown?: number
  readonly temperature?: number
  readonly effort?: EffortLevel
}): AgentClassGenes {
  return {
    ...(source.description !== undefined ? { description: source.description } : {}),
    ...(source.tools !== undefined ? { tools: source.tools } : {}),
    ...(source.contextStrategy !== undefined ? { contextStrategy: source.contextStrategy } : {}),
    ...(source.model !== undefined ? { model: source.model } : {}),
    ...(source.sendCountdown !== undefined ? { sendCountdown: source.sendCountdown } : {}),
    ...(source.temperature !== undefined ? { temperature: source.temperature } : {}),
    ...(source.effort !== undefined ? { effort: source.effort } : {}),
  }
}


