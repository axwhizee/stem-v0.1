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
// 依赖注入（组合根装配）：
//   - askRoot：投递申请消息到根信箱（contextManager.deposit）；
//   - getRoot：解析申请者的族谱根（lineage.getRoot），用于 reply 授权校验。
// ============================================================

import type { LogSink } from '../logging'
import { evaluateAccess } from './access'
import type {
  AccessAssertInput,
  AccessError,
  AccessReplyInput,
  AccessRequest,
  ToolAccessRule,
  ToolAccessRules,
} from './types'

export interface AccessAskOptions {
  /** 投递访问申请消息到根 agent 信箱（组合根注入：contextManager.deposit + from=申请者）。 */
  readonly askRoot: (request: AccessRequest) => Promise<void> | void
  /** 解析申请者的族谱根（注入 lineage.getRoot；用于 access_reply 授权校验）。 */
  readonly getRoot: (agentId: string) => string
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
  /** session 内已批准规则（always 累积，仅当前实例生效，不传播后代）。 */
  readonly approvedRules: () => ToolAccessRules
}

interface PendingEntry {
  readonly info: AccessRequest
  readonly resolve: () => void
  readonly reject: (error: AccessError) => void
}

export class DefaultAccessAskBus implements AccessAskBus {
  private readonly approved: ToolAccessRule[] = []
  private readonly pending = new Map<string, PendingEntry>()
  private readonly askRoot: (request: AccessRequest) => Promise<void> | void
  private readonly getRoot: (agentId: string) => string
  private readonly autoApprove: boolean
  private readonly nextRequestId?: () => string
  private readonly onLog?: LogSink
  private counter = 0

  constructor(options: AccessAskOptions) {
    this.askRoot = options.askRoot
    this.getRoot = options.getRoot
    this.autoApprove = options.autoApprove ?? false
    this.nextRequestId = options.nextRequestId
    this.onLog = options.onLog
  }

  async assert(input: AccessAssertInput): Promise<void> {
    // 分层评估：kernel 合成的完整访问层（全局 → 祖先链 → agent 类）
    // 追加 session 批准（仅当前实例），层间取最严格（单向收缩）。
    const action = evaluateAccess(input.accessKey, [...(input.layers ?? []), this.approved], input.defaultAccess)
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
    // ask：autoApprove 放行，否则投递申请到根信箱并挂起等根回复。
    if (this.autoApprove) return
    const info: AccessRequest = {
      id: this.nextRequestId?.() ?? `access_${++this.counter}`,
      accessKey: input.accessKey,
      agentId: input.agentId,
      metadata: input.metadata,
      at: Date.now(),
    }
    await new Promise<void>((resolve, reject) => {
      this.pending.set(info.id, { info, resolve, reject })
      void this.askRoot(info)
    })
  }

  async reply(input: AccessReplyInput, by: string): Promise<void> {
    const entry = this.pending.get(input.requestId)
    if (!entry) {
      throw { kind: 'access_request_not_found', requestId: input.requestId } satisfies AccessError
    }
    // 授权校验：仅申请者的族谱根可回复（一般即 user0）。
    if (by !== this.getRoot(entry.info.agentId)) {
      throw { kind: 'access_denied', accessKey: entry.info.accessKey, agentId: entry.info.agentId } satisfies AccessError
    }
    this.pending.delete(input.requestId)
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
      // 根批准优先于类规则：加入 approved，后续同访问键直接通过。
      this.approved.push({ key: entry.info.accessKey, action: 'allow' })
    }
    entry.resolve()
  }

  list(): readonly AccessRequest[] {
    return [...this.pending.values()].map((entry) => entry.info)
  }

  approvedRules(): ToolAccessRules {
    return [...this.approved]
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