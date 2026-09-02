// ============================================================
// shell/dashboard/cleanup.ts —— 空间清理工具（唯一写通道，门禁见 server）
//
// 语义边界：terminate 归档保语料是设计（历史价值），GC 是**显式法医动作**；
// 若同空间 shell 实例正在运行（一进程=一空间约定），其内存态写穿会覆盖
// 本层删除——故写连接必须 `--allow-write` 显式开启 + 操作需 confirm 参数，
// UI 双确认兜底。不提供伪自动检测（无锁是既定裁决，不假装机制存在）。
// ============================================================

import { DatabaseSync } from 'node:sqlite'

export interface CleanupPreview {
  /** 孤儿消息箱：messages.agent_id 不在 instances 中（实例行已删/从未登记）。 */
  readonly orphanAgents: readonly string[]
  readonly orphanRows: number
  /** terminated 实例（其语料为 GC 候选）。 */
  readonly terminatedAgents: readonly string[]
  readonly terminatedRows: number
  readonly archivedRows: number
  /** freelist 可回收字节（VACUUM 收益估计）。 */
  readonly reclaimableBytes: number
  readonly totalRows: number
}

interface InstanceLite {
  readonly id: string
  readonly status?: string
}

function allInstances(db: DatabaseSync): InstanceLite[] {
  return (db.prepare('SELECT instance FROM instances').all() as Array<{ instance: string }>).map(
    (r) => JSON.parse(r.instance) as InstanceLite,
  )
}

export function cleanupPreview(db: DatabaseSync): CleanupPreview {
  const instances = allInstances(db)
  const ids = new Set(instances.map((i) => i.id))
  const terminated = instances.filter((i) => i.status === 'terminated').map((i) => i.id)
  const msgAgents = db.prepare('SELECT DISTINCT agent_id AS a FROM messages').all() as Array<{ a: string }>
  const orphans = msgAgents.map((r) => r.a).filter((a) => !ids.has(a))
  const ph = (list: readonly string[]) => list.map(() => '?').join(',')
  const orphanRows = orphans.length === 0 ? 0 : (db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE agent_id IN (${ph(orphans)})`).get(...orphans) as { c: number }).c
  const terminatedRows = terminated.length === 0 ? 0 : (db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE agent_id IN (${ph(terminated)})`).get(...terminated) as { c: number }).c
  const archivedRows = (db.prepare('SELECT COUNT(*) AS c FROM messages WHERE archived = 1').get() as { c: number }).c
  const { page_count = 0, freelist_count = 0, page_size = 4096 } = {
    page_count: (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count,
    freelist_count: (db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count,
    page_size: (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size,
  }
  return {
    orphanAgents: orphans,
    orphanRows,
    terminatedAgents: terminated,
    terminatedRows,
    archivedRows,
    reclaimableBytes: freelist_count * page_size,
    totalRows: (db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c ?? 0,
  }
}

export type CleanupAction = 'gc-orphans' | 'gc-terminated' | 'purge-agent' | 'vacuum'

export interface CleanupResult {
  readonly action: CleanupAction
  readonly deletedRows: number
  readonly ok: boolean
  readonly note?: string
}

/** 执行清理动作（confirm 必须由调用方带 'yes'——server 层已挡，双保险）。 */
export function runCleanup(
  db: DatabaseSync,
  action: CleanupAction,
  opts: { readonly agentId?: string; readonly force?: boolean } = {},
): CleanupResult {
  if (action === 'vacuum') {
    const before = cleanupPreview(db)
    db.exec('VACUUM')
    return { action, deletedRows: 0, ok: true, note: `回收约 ${before.reclaimableBytes} 字节` }
  }
  if (action === 'purge-agent') {
    const agentId = opts.agentId
    if (agentId === undefined || agentId === '') return { action, deletedRows: 0, ok: false, note: '缺少 agentId' }
    const inst = db.prepare('SELECT instance FROM instances WHERE id = ?').get(agentId) as { instance: string } | undefined
    const status = inst === undefined ? undefined : (JSON.parse(inst.instance) as InstanceLite).status
    if (status !== undefined && status !== 'terminated' && opts.force !== true) {
      return { action, deletedRows: 0, ok: false, note: `agent ${agentId} 状态为 ${status}（非 terminated）——确认自担风险可加 force` }
    }
    const del = db.prepare('DELETE FROM messages WHERE agent_id = ?').run(agentId)
    db.prepare('DELETE FROM instances WHERE id = ?').run(agentId)
    return { action, deletedRows: Number(del.changes ?? 0), ok: true, note: `已删实例行与语料（agent ${agentId}）` }
  }
  if (action === 'gc-orphans') {
    const preview = cleanupPreview(db)
    if (preview.orphanAgents.length === 0) return { action, deletedRows: 0, ok: true, note: '无孤儿箱' }
    const ph = preview.orphanAgents.map(() => '?').join(',')
    const del = db.prepare(`DELETE FROM messages WHERE agent_id IN (${ph})`).run(...preview.orphanAgents)
    return { action, deletedRows: Number(del.changes ?? 0), ok: true, note: `清理孤儿箱 ${preview.orphanAgents.length} 个` }
  }
  // gc-terminated：terminated 实例的全部语料行（含归档）+ 实例行本身保留（族谱墓碑）
  const preview = cleanupPreview(db)
  if (preview.terminatedAgents.length === 0) return { action, deletedRows: 0, ok: true, note: '无 terminated 实例' }
  const ph = preview.terminatedAgents.map(() => '?').join(',')
  const del = db.prepare(`DELETE FROM messages WHERE agent_id IN (${ph})`).run(...preview.terminatedAgents)
  return { action, deletedRows: Number(del.changes ?? 0), ok: true, note: `已 GC ${preview.terminatedAgents.length} 个 terminated agent 的语料（实例墓碑保留）` }
}
