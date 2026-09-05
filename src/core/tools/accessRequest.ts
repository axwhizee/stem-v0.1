// ============================================================
// core/tools/accessRequest.ts —— ask 权限消息化（取代 AccessManager 耦合通道）
//
// 扁平化设计：ask 审批是**消息交换**，不是系统耦合通道。
//   - 工具权限评估命中 ask → assert 自动触发「投递申请消息到申请者的
//     族谱根 agent 信箱」（机制同向模型发消息），并挂起等待回复；
//   - 根 agent（一般即 user0）经 access_reply 工具批准/拒绝
//     （once/always/reject），bus.reply 解析挂起。
//   - 无任何 agent 特判：user0 也是普通 agent，其自身 ask 同样发给自己
//     的根（= 自己），由扮演它的 shell 经 pilot 确认。
//
// 权限评估（查询反转）：生效访问经注入的 AccessResolver 端口向族谱台账
//   （lineage/AccessLedger）查询，本模块不再接收/拼装任何权限层；
//   族谱无判定时落 defaultAccess（internal → ignore，其余 → ask）。
//
// session 豁免备忘（once/always 的正确语义）：
//   - always 批准 = 该 (agent, accessKey) 后续**免于询问**（ask 静默放行），
//     仅当前实例生效、不传播后代；它是 ask 环节的备忘，**不是权限层**——
//     不参与单调收敛，绝不豁免 deny/ignore（旧实现把 allow 规则混进分层
//     取严，ask 永远压不掉，且跨 agent 泄漏）。
//
// 依赖注入（组合根装配）：
//   - resolve：族谱权限查询端口（kernel 接线 AccessLedger）；
//   - askRoot：投递申请消息到根信箱（contextManager.deposit）；
//   - getRoot：解析申请者的族谱根（lineage.getRoot），用于 reply 授权校验。
// ============================================================

import { forget } from '../logging'
import type { LogSink } from '../logging'
import type {
  AccessAssertInput,
  AccessError,
  AccessReplyInput,
  AccessRequest,
  AccessResolver,
} from './types'

export interface AccessAskOptions {
  /** 投递访问申请消息到根 agent 信箱（组合根注入：contextManager.deposit + from=申请者）。 */
  readonly askRoot: (request: AccessRequest) => Promise<void> | void
  /** 解析申请者的族谱根（注入 lineage.getRoot；用于 access_reply 授权校验）。 */
  readonly getRoot: (agentId: string) => string
  /** 族谱权限查询端口（kernel 接线 AccessLedger；缺省 = 全部走 defaultAccess）。 */
  readonly resolve?: AccessResolver
  /** 访问自动批准（配置 `autoApprove`）：true 时 ask 直接放行。 */
  readonly autoApprove?: boolean
  /** 可注入请求 id 生成器（测试用）。 */
  readonly nextRequestId?: () => string
  /** 日志出口（组合根注入 → core/logging）。 */
  readonly onLog?: LogSink
}

export interface AccessAskBus {
  /** 断言访问：allow/ignore 通过 / deny 抛错 / ask 投递申请到根信箱并挂起。 */
  readonly assert: (input: AccessAssertInput) => Promise<void>
  /** 根 agent 回复（by = access_reply 调用者；须是申请者的族谱根）。 */
  readonly reply: (input: AccessReplyInput, by: string) => Promise<void>
  /** 列出挂起中的请求。 */
  readonly list: () => readonly AccessRequest[]
  /** session 已豁免的 (agent, accessKey) 备忘（always 累积；仅 ask 环节生效）。 */
  readonly listApprovals: () => readonly { agentId: string; accessKey: string }[]
}

interface PendingEntry {
  readonly info: AccessRequest
  readonly resolve: () => void
  readonly reject: (error: AccessError) => void
}

/** 豁免备忘键（agent 隔离：不同实例同键互不影响）。 */
function memoKey(agentId: string, accessKey: string): string {
  return `${agentId}\u0000${accessKey}`
}

export class DefaultAccessAskBus implements AccessAskBus {
  private readonly approvals = new Map<string, { agentId: string; accessKey: string }>()
  private readonly pending = new Map<string, PendingEntry>()
  private readonly askRoot: (request: AccessRequest) => Promise<void> | void
  private readonly getRoot: (agentId: string) => string
  private readonly resolvePort: AccessResolver | undefined
  private readonly autoApprove: boolean
  private readonly nextRequestId?: () => string
  private readonly onLog?: LogSink
  private counter = 0

  constructor(options: AccessAskOptions) {
    this.askRoot = options.askRoot
    this.getRoot = options.getRoot
    this.resolvePort = options.resolve
    this.autoApprove = options.autoApprove ?? false
    this.nextRequestId = options.nextRequestId
    this.onLog = options.onLog
  }

  async assert(input: AccessAssertInput): Promise<void> {
    // 族谱台账查询（生效权限 = 族谱位置的函数）；无判定 → 工具默认值。
    const action =
      this.resolvePort?.accessOf(input.agentId, input.accessKey) ?? input.defaultAccess ?? 'ask'
    this.onLog?.log({
      type: 'access.asked',
      at: Date.now(),
      agentId: input.agentId,
      accessKey: input.accessKey,
      action,
    })
    if (action === 'allow' || action === 'ignore') return
    if (action === 'deny') {
      throw { kind: 'access_denied', accessKey: input.accessKey, agentId: input.agentId } satisfies AccessError
    }
    // ask：autoApprove 放行；已被 always 豁免（同 agent 同键）静默通过；
    // 否则投递申请到根信箱并挂起等根回复。
    if (this.autoApprove) return
    if (this.approvals.has(memoKey(input.agentId, input.accessKey))) return
    const info: AccessRequest = {
      id: this.nextRequestId?.() ?? `access_${++this.counter}`,
      accessKey: input.accessKey,
      agentId: input.agentId,
      metadata: input.metadata,
      at: Date.now(),
    }
    await new Promise<void>((resolve, reject) => {
      this.pending.set(info.id, { info, resolve, reject })
      forget(Promise.resolve(this.askRoot(info)), 'ask:askRoot', this.onLog)
    })
  }

  async reply(input: AccessReplyInput, by: string): Promise<void> {
    const entry = this.pending.get(input.requestId)
    if (!entry) {
      throw {
        kind: 'access_request_not_found',
        requestId: input.requestId,
        message: `无此待批申请（requestId=${input.requestId}）——可能已被答复或申请者已注销；用 telemetry 查 access.asked 事件核对在场申请`,
      } satisfies AccessError
    }
    // 授权校验：仅申请者的族谱根可回复（一般即 user0）。
    if (by !== this.getRoot(entry.info.agentId)) {
      throw {
        kind: 'access_reply_not_root',
        accessKey: entry.info.accessKey,
        agentId: entry.info.agentId,
        message: '答复权专属申请者的族谱根（一般是 user0）——你不是根，请停止重试并等待根的答复（申请者此刻正挂起等待）',
      } satisfies AccessError
    }
    this.pending.delete(input.requestId)
    // 总序防御：挂起期间该键被运行期收敛改严为 deny——迟到的批准被铁律压死
    // （不写 always 备忘；复核即台账现值查询，无新端口）。
    if (input.reply !== 'reject' && this.resolvePort?.accessOf(entry.info.agentId, entry.info.accessKey) === 'deny') {
      this.onLog?.log({
        type: 'access.replied',
        at: Date.now(),
        agentId: entry.info.agentId,
        accessKey: entry.info.accessKey,
        requestId: entry.info.id,
        reply: 'reject',
      })
      entry.reject({
        kind: 'access_rejected',
        accessKey: entry.info.accessKey,
        requestId: entry.info.id,
        feedback: '该工具在申请挂起期间已被族谱权限收敛为 deny——批准不得盖过铁律',
      })
      return
    }
    this.onLog?.log({
      type: 'access.replied',
      at: Date.now(),
      agentId: entry.info.agentId,
      accessKey: entry.info.accessKey,
      requestId: entry.info.id,
      reply: input.reply,
    })
    if (input.reply === 'reject') {
      entry.reject({
        kind: 'access_rejected',
        accessKey: entry.info.accessKey,
        requestId: entry.info.id,
        feedback: input.message,
      })
      return
    }
    if (input.reply === 'always') {
      // 豁免备忘（仅该 agent 该键）：后续 ask 免询问放行，deny/ignore 不受影响。
      this.approvals.set(memoKey(entry.info.agentId, entry.info.accessKey), {
        agentId: entry.info.agentId,
        accessKey: entry.info.accessKey,
      })
    }
    entry.resolve()
  }

  list(): readonly AccessRequest[] {
    return [...this.pending.values()].map((entry) => entry.info)
  }

  listApprovals(): readonly { agentId: string; accessKey: string }[] {
    return [...this.approvals.values()]
  }
}

/** 格式化访问申请消息（投递到根信箱的 user 消息内容；带请求 id 供 access_reply 答复）。 */
export function formatAccessRequest(request: AccessRequest): string {
  const meta = request.metadata ? `（${JSON.stringify(request.metadata)}）` : ''
  return (
    `<access_request id="${request.id}" accessKey="${request.accessKey}" agentId="${request.agentId}">` +
    `agent ${request.agentId} 申请使用工具「${request.accessKey}」${meta}。` +
    `请用 access_reply 工具答复（requestId=${request.id}）。</access_request>`
  )
}
