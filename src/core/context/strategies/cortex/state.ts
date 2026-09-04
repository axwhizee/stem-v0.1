// ============================================================
// core/context/strategies/cortex/state.ts —— cortex 运行时状态
//
// 每进程一份（策略工厂闭包持有）。核心是**全局 dream token**：
//   - 同一空间同时至多一个梦（串行——梦是后台整理，频率天然低，
//     串行换掉 worker 身份解析的全部歧义：工具只需问"做梦在途吗"）；
//   - token 存在 = dream worker 可能正在调用 cortex_* 工具，四枚工具
//     把操作写进 token 的 staging（纯内存）；token 缺位 = agent 直写
//     通道（add/del_note 立即落盘）；
//   - runDream 收口统一消费 staging（笔记以 host 身份落盘 → 事务判
//     定 → 轮替）。工具面零 fs 零 api 零特权。
// 持久事实全在仓库行与文件（本模块只有"这一次梦"的临时态；重启即清
// 无碍——半途梦不轮替，下一封信自然重触发）。
// ============================================================

import type { LtmItem } from './schema'

/** 暂存的笔记操作（commit 时以 host 身份落盘）。 */
export interface NoteOp {
  readonly op: 'add' | 'del'
  readonly name: string
  readonly content?: string
}

/** 一次梦的暂存区。 */
export interface DreamToken {
  readonly hostId: string
  /** 调用者 agentId → 操作队列（worker 条目由 runDream 迁移到 host 目录）。 */
  readonly staging: Map<string, { ltm?: LtmItem[]; stm?: string; notes: NoteOp[] }>
}

/** 宿主 agent 的长驻状态。 */
export interface HostState {
  /** 参数告警去重（warn-once）。 */
  warned: Set<string>
}

export class CortexRuntime {
  dream: DreamToken | undefined
  readonly #hosts = new Map<string, HostState>()

  host(agentId: string): HostState {
    let s = this.#hosts.get(agentId)
    if (!s) {
      s = { warned: new Set() }
      this.#hosts.set(agentId, s)
    }
    return s
  }

  begin(hostId: string): DreamToken {
    const token: DreamToken = { hostId, staging: new Map() }
    this.dream = token
    return token
  }

  #bucket(callerId: string): { ltm?: LtmItem[]; stm?: string; notes: NoteOp[] } {
    const t = this.dream
    if (!t) throw { kind: 'cortex_dream_inactive' }
    let b = t.staging.get(callerId)
    if (!b) {
      b = { notes: [] }
      t.staging.set(callerId, b)
    }
    return b
  }

  stageLtm(callerId: string, items: LtmItem[]): void {
    this.#bucket(callerId).ltm = items
  }

  stageStm(callerId: string, markdown: string): void {
    this.#bucket(callerId).stm = markdown
  }

  stageNote(callerId: string, note: NoteOp): void {
    this.#bucket(callerId).notes.push(note)
  }

  /** 梦是否在进行且 caller 不是做梦 host 本体（= 判定为 worker 通道）。 */
  isDreamWorker(callerId: string): boolean {
    return this.dream !== undefined && callerId !== this.dream.hostId
  }

  /** 收口：合并所有 caller 的暂存（worker 操作迁移到 host 名下）。 */
  drain(): { ltm: LtmItem[] | undefined; stm: string | undefined; notes: NoteOp[] } {
    const t = this.dream
    this.dream = undefined
    if (!t) return { ltm: undefined, stm: undefined, notes: [] }
    let ltm: LtmItem[] | undefined
    let stm: string | undefined
    const notes: NoteOp[] = []
    for (const bucket of t.staging.values()) {
      if (bucket.ltm !== undefined) ltm = bucket.ltm
      if (bucket.stm !== undefined) stm = bucket.stm
      notes.push(...bucket.notes)
    }
    return { ltm, stm, notes }
  }

  /** 异常路径也要释放全局锁（防死锁）。 */
  abort(): void {
    this.dream = undefined
  }
}
