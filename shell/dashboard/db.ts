// ============================================================
// shell/dashboard/db.ts —— 空间持久层只读查询（法医视图数据源）
//
// 设计：仪表盘不侵入运行进程——个体层是同步 write-through 的，
// DB 行即运行态镜像（status/tokens/cost 皆实时落行），故只读连接
// 即可获得族谱、账目、语料的近实时全量视图，与 webui 真并列零冲突。
// 行 = 记录全量 JSON（messages.message 列存 StoredMessage，
// instances.instance 列存 AgentInstance），json_extract 直查。
// ============================================================

import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { statSync } from 'node:fs'

/** 打开空间 DB（文件不存在 = 未出生的空间，返回 undefined 由上层显示空态）。 */
export function openDb(file: string, opts: { readonly readonly?: boolean } = {}): DatabaseSync | undefined {
  if (!existsSync(file)) return undefined
  return new DatabaseSync(file, opts.readonly === false ? {} : { readOnly: true })
}

export function dbBytes(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

// ---------- 族谱行（instances 行 + messages 聚合） ----------

export interface DashAgentRow {
  readonly id: string
  readonly name?: string
  readonly classRef: string
  readonly parentId: string | null
  readonly status: string
  readonly spaceId: string
  readonly turnCount: number
  readonly totalCost: number
  readonly model?: string
  readonly modelSnapshot?: string
  readonly msgs: number
  readonly tokens: number
  readonly lastAt: number | null
  readonly lastPrompt?: string
  readonly lastPromptFrom?: string
}

interface RawInstance {
  readonly id: string
  readonly classRef: string
  readonly parentId: string | null
  readonly name?: string
  readonly status: string
  readonly spaceId: string
  readonly turnCount: number
  readonly totalCost: number
  readonly model?: { provider: string; id: string }
  readonly modelSnapshot?: { provider: string; id: string }
}

function refText(model: RawInstance['model']): string | undefined {
  return model === undefined ? undefined : `${model.provider}/${model.id}`
}

/** 族谱全量行（含 terminated——法医视角不隐藏尸体，UI 端做状态编码）。 */
export function dashAgents(db: DatabaseSync): DashAgentRow[] {
  const instances = (db.prepare('SELECT instance FROM instances ORDER BY rowid').all() as Array<{ instance: string }>).map(
    (r) => JSON.parse(r.instance) as RawInstance,
  )
  const agg = new Map<string, { msgs: number; tokens: number }>()
  for (const row of db
    .prepare(
      `SELECT agent_id AS a, COUNT(*) AS c, COALESCE(SUM(json_extract(message, '$.tokens')), 0) AS t
       FROM messages WHERE archived = 0 GROUP BY agent_id`,
    )
    .all() as Array<{ a: string; c: number; t: number }>) {
    agg.set(row.a, { msgs: row.c, tokens: row.t })
  }
  // 每 agent 最新 user 信（先滤 user 行再取窗口末位——尾行未必是 user）。
  const tails = new Map<string, { at: number; content: string }>()
  for (const row of db
    .prepare(
      `SELECT a, content, at FROM (
         SELECT agent_id AS a,
                json_extract(message, '$.at') AS at,
                json_extract(message, '$.message.content') AS content,
                ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY seq DESC) AS rn
         FROM messages
         WHERE archived = 0 AND json_extract(message, '$.message.role') = 'user'
       ) WHERE rn = 1`,
    )
    .all() as Array<{ a: string; at: number; content: string }>) {
    if (typeof row.content === 'string') tails.set(row.a, { at: row.at, content: row.content })
  }
  return instances.map((inst) => {
    const stats = agg.get(inst.id) ?? { msgs: 0, tokens: 0 }
    const tail = tails.get(inst.id)
    const raw = tail?.content ?? ''
    const sender = /^<sender id="([^"]+)"(?: at="[^"]*")?>/.exec(raw)?.[1] ?? ''
    const prompt = raw.replace(/^<sender id="[^"]+"(?: at="[^"]*")?>/, '').replace(/<\/sender>$/, '')
    return {
      id: inst.id,
      ...(inst.name !== undefined ? { name: inst.name } : {}),
      classRef: inst.classRef,
      parentId: inst.parentId,
      status: inst.status,
      spaceId: inst.spaceId,
      turnCount: inst.turnCount,
      totalCost: inst.totalCost,
      ...(refText(inst.model) !== undefined ? { model: refText(inst.model) } : {}),
      ...(refText(inst.modelSnapshot) !== undefined ? { modelSnapshot: refText(inst.modelSnapshot) } : {}),
      msgs: stats.msgs,
      tokens: stats.tokens,
      lastAt: tail?.at ?? null,
      ...(prompt !== '' ? { lastPrompt: prompt, lastPromptFrom: sender } : {}),
    }
  })
}

// ---------- 汇总卡 ----------

export interface DashSummary {
  readonly dbBytes: number
  readonly messages: { total: number; archived: number; valid: number }
  readonly tokensTotal: number
  readonly tokensValid: number
  readonly instances: { total: number; byStatus: Record<string, number> }
  readonly spaces: number
  readonly schemaVersion: number
  readonly lastActivity: number | null
}

export function summary(db: DatabaseSync, file: string): DashSummary {
  const one = <T>(sql: string): T => db.prepare(sql).get() as T
  const messages = one<{ total: number; archived: number }>('SELECT COUNT(*) AS total, COALESCE(SUM(archived), 0) AS archived FROM messages')
  const tokens = one<{ totalAll: number; validSum: number }>(
    `SELECT COALESCE(SUM(json_extract(message, '$.tokens')), 0) AS totalAll,
            COALESCE(SUM(CASE WHEN archived = 0 AND json_extract(message, '$.valid') = 1 THEN json_extract(message, '$.tokens') ELSE 0 END), 0) AS validSum
     FROM messages`,
  )
  const byStatus: Record<string, number> = {}
  for (const r of db.prepare('SELECT instance FROM instances').all() as Array<{ instance: string }>) {
    const st = (JSON.parse(r.instance) as RawInstance).status
    byStatus[st] = (byStatus[st] ?? 0) + 1
  }
  const last = one<{ at: number | null }>('SELECT MAX(json_extract(message, \'$.at\')) AS at FROM messages')
  return {
    dbBytes: dbBytes(file),
    messages: { total: messages.total, archived: messages.archived, valid: messages.total - messages.archived },
    tokensTotal: tokens.totalAll,
    tokensValid: tokens.validSum,
    instances: { total: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus },
    spaces: one<{ c: number }>('SELECT COUNT(*) AS c FROM spaces').c,
    schemaVersion: (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    lastActivity: last.at ?? null,
  }
}

// ---------- token 账目 ----------

export interface AgentTokenStat {
  readonly agentId: string
  readonly msgs: number
  readonly tokens: number
  readonly byRole: Record<string, number>
  readonly byTag: Record<string, number>
}

export function tokenStats(db: DatabaseSync): {
  byAgent: AgentTokenStat[]
  byDay: Array<{ day: string; tokens: number; msgs: number }>
  total: { msgs: number; tokens: number }
} {
  const perRow = db
    .prepare(
      `SELECT agent_id AS a,
              json_extract(message, '$.message.role') AS role,
              json_extract(message, '$.tag') AS tag,
              json_extract(message, '$.tokens') AS tokens,
              strftime('%Y-%m-%d', json_extract(message, '$.at') / 1000, 'unixepoch', 'localtime') AS day
       FROM messages WHERE archived = 0`,
    )
    .all() as Array<{ a: string; role: string; tag: string | null; tokens: number; day: string }>
  // 累加用可变形状（导出时结构兼容只读 AgentTokenStat）。
  const agents = new Map<string, { agentId: string; msgs: number; tokens: number; byRole: Record<string, number>; byTag: Record<string, number> }>()
  const days = new Map<string, { tokens: number; msgs: number }>()
  let total: { msgs: number; tokens: number } = { msgs: 0, tokens: 0 }
  for (const r of perRow) {
    let agg = agents.get(r.a)
    if (agg === undefined) {
      agg = { agentId: r.a, msgs: 0, tokens: 0, byRole: {}, byTag: {} }
      agents.set(r.a, agg)
    }
    agg.msgs += 1
    agg.tokens += r.tokens
    agg.byRole[r.role] = (agg.byRole[r.role] ?? 0) + r.tokens
    if (r.tag !== null && r.tag !== undefined) agg.byTag[r.tag] = (agg.byTag[r.tag] ?? 0) + r.tokens
    const d = days.get(r.day) ?? { tokens: 0, msgs: 0 }
    d.tokens += r.tokens
    d.msgs += 1
    days.set(r.day, d)
    total = { msgs: total.msgs + 1, tokens: total.tokens + r.tokens }
  }
  return {
    byAgent: [...agents.values()].sort((x, y) => y.tokens - x.tokens),
    byDay: [...days.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([day, v]) => ({ day, ...v })),
    total,
  }
}

// ---------- 语料浏览 ----------

export interface MessageLite {
  readonly id: string
  readonly agentId: string
  readonly role: string
  readonly tag?: string
  readonly from?: string
  readonly tokens: number
  readonly turn: number
  readonly indexInTurn: number
  readonly valid: boolean
  readonly archived: boolean
  readonly at: number
  readonly preview: string
}

export function listMessages(
  db: DatabaseSync,
  opts: { agentId?: string; limit?: number; offset?: number; includeArchived?: boolean } = {},
): { rows: MessageLite[]; total: number } {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  const offset = Math.max(opts.offset ?? 0, 0)
  const where: string[] = []
  const params: Array<string | number> = []
  if (!opts.includeArchived) where.push('archived = 0')
  if (opts.agentId !== undefined && opts.agentId !== '') {
    where.push('agent_id = ?')
    params.push(opts.agentId)
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM messages ${clause}`).get(...params) as { c: number }).c
  const rows = db
    .prepare(
      `SELECT message, archived FROM messages ${clause} ORDER BY agent_id, seq LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Array<{ message: string; archived: number }>
  const lite = rows.map((r) => {
    const m = JSON.parse(r.message) as {
      id: string; agentId: string; message: { role: string; content: unknown }
      tokens: number; turn: number; indexInTurn: number; valid: boolean; at: number; tag?: string; from?: string
    }
    const content = typeof m.message.content === 'string' ? m.message.content : JSON.stringify(m.message.content)
    return {
      id: m.id,
      agentId: m.agentId,
      role: m.message.role,
      ...(m.tag !== undefined ? { tag: m.tag } : {}),
      ...(m.from !== undefined ? { from: m.from } : {}),
      tokens: m.tokens,
      turn: m.turn,
      indexInTurn: m.indexInTurn,
      valid: m.valid,
      archived: r.archived === 1,
      at: m.at,
      preview: content.length > 220 ? `${content.slice(0, 220)}…` : content,
    }
  })
  return { rows: lite, total }
}

// ---------- 原表浏览（法医：直接看落盘行） ----------

export function rawTable(
  db: DatabaseSync,
  table: 'messages' | 'instances' | 'spaces',
  limit = 50,
  offset = 0,
): { columns: string[]; rows: Array<Record<string, unknown>>; total: number } {
  const n = Math.min(Math.max(limit, 1), 200)
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT ? OFFSET ?`).all(n, offset) as Array<Record<string, unknown>>
  const columns = rows.length > 0 ? Object.keys(rows[0]!) : table === 'messages' ? ['id', 'agent_id', 'seq', 'message', 'archived'] : ['id', table === 'spaces' ? 'space' : 'instance']
  // JSON 列展开为 pretty 文本（前端 <pre> 呈现）。
  const pretty = rows.map((r) => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'string' && (k === 'message' || k === 'instance' || k === 'space')) {
        try {
          out[k] = JSON.stringify(JSON.parse(v), null, 1)
        } catch {
          out[k] = v
        }
      } else out[k] = v
    }
    return out
  })
  return { columns, rows: pretty, total }
}
