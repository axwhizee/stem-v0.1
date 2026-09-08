// ============================================================
// shell/feishu/config.ts —— 飞书 shell 自治理配置（`.stem/feishu.jsonc`）
//
// 凭证永不进此文件（FEISHU_APP_ID / FEISHU_APP_SECRET 只走 env，
// 对齐 providers.key_env 的"配置永不承载明文密钥"精神）。
// 本文件属 shell 层平台配置，不进 core StemConfig（R12 未知键禁入）。
// ============================================================

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'

export interface FeishuConfig {
  /** 主人 open_id 白名单（空 = 拒服并打印来话者 open_id，人工回填后重启认领）。 */
  readonly ownerOpenIds: readonly string[]
  /** 单聊默认接待员类（缺省内置 assistant 占位类；根（user#0）是面板不跑轮，聊天对象必为实例）。 */
  readonly secretaryClass: string
  /** 会话绑定：chat_id → 目标 agent id（未绑定 = 单聊落接待员、群聊拒服）。 */
  readonly chatBindings: Readonly<Record<string, string>>
  /** 审批卡额外投递的群（审批本身恒达主人单聊）。 */
  readonly approvalChatIds: readonly string[]
  /** watch 推送汇聚节流窗（毫秒，同目标窗内事件并一条）。 */
  readonly watchThrottleMs: number
}

export const FEISHU_CONFIG_DEFAULTS: FeishuConfig = {
  ownerOpenIds: [],
  secretaryClass: 'assistant',
  chatBindings: {},
  approvalChatIds: [],
  watchThrottleMs: 2000,
}

/** 装载 `.stem/feishu.jsonc`（缺文件 = 全缺省；未知顶层键 fail-fast 与 core 配置同律）。 */
export function loadFeishuConfig(projectRoot: string): FeishuConfig {
  const file = join(projectRoot, '.stem', 'feishu.jsonc')
  if (!existsSync(file)) return { ...FEISHU_CONFIG_DEFAULTS }
  // 裸 JSONC 解析（core parseConfigText 携带 StemConfig R12 语义，不适用平台侧文件）。
  const raw = parseJsonc(readFileSync(file, 'utf8'), []) as Record<string, unknown> | null
  const known = new Set(['ownerOpenIds', 'secretaryClass', 'chatBindings', 'approvalChatIds', 'watchThrottleMs'])
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
    approvalChatIds: strArray(raw.approvalChatIds) ?? d.approvalChatIds,
    watchThrottleMs: typeof raw.watchThrottleMs === 'number' ? raw.watchThrottleMs : d.watchThrottleMs,
  }
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
