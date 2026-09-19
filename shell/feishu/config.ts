// ============================================================
// shell/feishu/config.ts —— 飞书 shell 自治理配置（`.stem/feishu.jsonc`）
//
// 凭证永不进此文件（FEISHU_APP_ID / FEISHU_APP_SECRET 只走 env，
// 对齐 providers.key_env 的"配置永不承载明文密钥"精神）。
// 本文件属 shell 层平台配置，不进 core StemConfig（R12 未知键禁入）。
//
// 会话模型（显式目标制）：`sessions` = chat_id → 当前目标 agent id，
// 由 /new /use /exit 命令维护并**回写本文件**（jsonc applyEdits 保用户
// 注释与排版）；`ownerChatId` = 主人 p2p 会话的最近值（上线/离线通知
// 与启动补偿的投递面，首条 p2p 来话自动记录后同样回写）。
// ============================================================

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, modify, applyEdits, format, type FormattingOptions } from 'jsonc-parser'

export interface FeishuConfig {
  /** 主人 open_id 白名单（空 = 拒服并打印来话者 open_id，人工回填后重启认领）。 */
  readonly ownerOpenIds: readonly string[]
  /** 单聊默认接待员类（**可选项，缺省 'assistant'**）；置 '' = 关闭秘书中转——未绑定会话只给指令指引。 */
  readonly secretaryClass: string
  /** 会话绑定：chat_id → 目标 agent id（显式会话表之外的静态兜底；未绑定且秘书关闭 = 拒投）。 */
  readonly chatBindings: Readonly<Record<string, string>>
  /** 显式会话目标：chat_id → 当前 agent id（运行期 /new /use /exit 维护，shell 回写本文件）。 */
  readonly sessions: Readonly<Record<string, string>>
  /** watch 推送汇聚节流窗（毫秒，同目标窗内事件并一条）。 */
  readonly watchThrottleMs: number
  /** 主人 p2p 会话最近值（上线/离线通知投递面；来话自动记录回写）。 */
  readonly ownerChatId: string
  /** 各会话最近处理消息的创建时刻（毫秒；断线补偿的增量起点，回写本文件）。 */
  readonly lastSeenAt: Readonly<Record<string, number>>
}

export const FEISHU_CONFIG_DEFAULTS: FeishuConfig = {
  ownerOpenIds: [],
  secretaryClass: 'assistant',
  chatBindings: {},
  sessions: {},
  watchThrottleMs: 2000,
  ownerChatId: '',
  lastSeenAt: {},
}

export const feishuConfigFile = (projectRoot: string): string => join(projectRoot, '.stem', 'feishu.jsonc')

/** 装载 `.stem/feishu.jsonc`（缺文件 = 全缺省；未知顶层键 fail-fast 与 core 配置同律）。 */
export function loadFeishuConfig(projectRoot: string): FeishuConfig {
  const file = feishuConfigFile(projectRoot)
  if (!existsSync(file)) return { ...FEISHU_CONFIG_DEFAULTS }
  // 裸 JSONC 解析（core parseConfigText 携带 StemConfig R12 语义，不适用平台侧文件）。
  const raw = parse(readFileSync(file, 'utf8'), []) as Record<string, unknown> | null
  const known = new Set(['ownerOpenIds', 'secretaryClass', 'chatBindings', 'sessions', 'watchThrottleMs', 'ownerChatId', 'lastSeenAt'])
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`[feishu] ${file} 顶层必须是对象`)
  }
  const unknown = Object.keys(raw).filter((k) => !known.has(k))
  if (unknown.length > 0) {
    throw new Error(`[feishu] ${file} 含未知顶层键 ${unknown.join(', ')}（允许: ${[...known].join(', ')}）`)
  }
  const d = FEISHU_CONFIG_DEFAULTS
  return {
    ownerOpenIds: strArray(raw.ownerOpenIds) ?? d.ownerOpenIds,
    secretaryClass: typeof raw.secretaryClass === 'string' ? raw.secretaryClass : d.secretaryClass,
    chatBindings: strRecord(raw.chatBindings) ?? d.chatBindings,
    sessions: strRecord(raw.sessions) ?? d.sessions,
    watchThrottleMs: typeof raw.watchThrottleMs === 'number' ? raw.watchThrottleMs : d.watchThrottleMs,
    ownerChatId: typeof raw.ownerChatId === 'string' ? raw.ownerChatId : d.ownerChatId,
    lastSeenAt: numRecord(raw.lastSeenAt) ?? d.lastSeenAt,
  }
}

// —— 回写面（jsonc 定点编辑：保用户注释与排版，只动目标键） ——

export type SessionPatch =
  | { readonly kind: 'session'; readonly chatId: string; readonly target: string | null }
  | { readonly kind: 'ownerChat'; readonly chatId: string }
  | { readonly kind: 'seen'; readonly chatId: string; readonly at: number }

/** 把会话态定点写回 feishu.jsonc（文件不存在 = 以缺省模板起步）。 */
export function patchFeishuConfig(projectRoot: string, patch: SessionPatch): void {
  const file = feishuConfigFile(projectRoot)
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '{\n}\n'
  const fmt: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: '\n' }
  let next = text
  const apply = (path: readonly string[], value: unknown): void => {
    const edits = modify(next, [...path], value, { formattingOptions: fmt })
    next = applyEdits(next, edits)
  }
  const remove = (path: readonly string[]): void => {
    const edits = modify(next, [...path], undefined, { formattingOptions: fmt })
    next = applyEdits(next, edits)
  }
  switch (patch.kind) {
    case 'session':
      if (patch.target === null) remove(['sessions', patch.chatId])
      else apply(['sessions', patch.chatId], patch.target)
      break
    case 'ownerChat':
      apply(['ownerChatId'], patch.chatId)
      break
    case 'seen':
      apply(['lastSeenAt', patch.chatId], patch.at)
      break
  }
  // 轻度整形（只补分隔空白，不动注释）。**必须整批 applyEdits 一次**——
  // 逐条应用会让后续 edit 的 offset 错位（实测把字符串内容切碎的教训）。
  const tidy = format(next, { offset: 0, length: next.length }, { insertSpaces: true, tabSize: 2, eol: '\n' })
  next = applyEdits(next, tidy)
  writeFileSync(file, next.endsWith('\n') ? next : `${next}\n`)
}

function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined
}

function strRecord(v: unknown): Record<string, string> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'string') return undefined
    out[k] = val
  }
  return out
}

function numRecord(v: unknown): Record<string, number> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const out: Record<string, number> = {}
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'number') return undefined
    out[k] = val
  }
  return out
}
