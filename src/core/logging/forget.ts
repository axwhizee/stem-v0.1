// ============================================================
// core/logging/forget.ts —— fire-and-forget 安全阀
//
// P6 现场教训：裸 `void promise` 的孤儿 rejection（对象错误）两次击落
// webui 进程。全系统 void 异步路径统一改走 forget()：
//   - `*not_found` / `terminated` 类 = terminate 竞态的**正常语义**（快递员
//     倒计时在箱注销前起爆等），静默丢弃；
//   - 其余 = 缺陷信号，落 kernel.orphan.error 针点存活不崩（原型期可用性优先）。
// ============================================================

import type { LogEvent } from './events'
import type { LogSink } from './Logger'

/** 竞态白名单（判别联合 kind 的常见收尾噪声）。 */
const RACE_KINDS = /not_found|terminated|already_closed/

/** 日志出口双形态（组合根注入对象口、CM 持函数口——统一适配）。 */
export type OrphanSink = LogSink | ((event: LogEvent) => void) | undefined

export function forget(promise: Promise<unknown>, site: string, sink?: OrphanSink): void {
  promise.catch((reason: unknown) => {
    const kind = (reason as { kind?: string } | undefined)?.kind
    if (typeof kind === 'string' && RACE_KINDS.test(kind)) return
    const event: LogEvent = {
      type: 'kernel.orphan.error',
      at: Date.now(),
      site,
      error: typeof kind === 'string' ? JSON.stringify(reason) : String(reason),
    }
    if (typeof sink === 'function') sink(event)
    else sink?.log(event)
  })
}
