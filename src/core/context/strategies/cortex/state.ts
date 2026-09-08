// ============================================================
// core/context/strategies/cortex/state.ts —— cortex 运行时状态
//
// 每进程一份（策略工厂闭包持有）。核心是**全局梦锁**：
//   - 同一空间同时至多一个梦（串行——梦是后台整理，频率天然低，
//     串行换来笔记归属路由的零歧义：工具只需问"做梦在途吗"）；
//   - token 存在 = worker 的笔记操作立即以 **host 名义**落盘（runDream
//     收口段不再消费暂存——回信即交付物，记忆写回走 rotateGroup）；
//   - token 缺位 = agent 直写通道（add/del_note 落 caller 自己的目录）。
// 旧"全局梦 token 暂存/分流"（stageLtm/stageStm/stageNote/drain）已随
// cortex_set_* 工具整体退役——dreamer 的输出 = 回信（schema 校验在
// spawn validate 通道，收口原子性住 runDream 收口段）。
// 持久事实全在仓库行与文件（本模块只有"这一次梦"的临时态；重启即清
// 无碍——半途梦不轮替，下一封信自然重触发）。
// ============================================================

/** 一次梦的在途记录（全局锁 + host 名义笔记的触碰计数，供事件账目）。 */
export interface DreamToken {
  readonly hostId: string
  /** worker 以 host 名义落盘的笔记数（add/del 各计一次）。 */
  notesTouched: number
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
    const token: DreamToken = { hostId, notesTouched: 0 }
    this.dream = token
    return token
  }

  /** 梦是否在进行且 caller 不是做梦 host 本体（= 笔记归属路由到 host）。 */
  isDreamWorker(callerId: string): boolean {
    return this.dream !== undefined && callerId !== this.dream.hostId
  }

  /** worker 笔记落账（立即以 host 名义落盘，这里只记数）。 */
  touchNote(): void {
    if (this.dream !== undefined) this.dream.notesTouched += 1
  }

  /** 收口/异常统一释放全局锁，并结出笔记触碰数。 */
  end(): number {
    const touched = this.dream?.notesTouched ?? 0
    this.dream = undefined
    return touched
  }
}
