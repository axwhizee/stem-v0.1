// ============================================================
// core/tools/accessRequest.ts -- ask permission messaging
//
// Flattened design: ask approval is a message exchange.
//   - tool access hit ask -> assert delivers request to root mailbox
//     and suspends waiting for reply via Waiter;
//   - root agent replies via access_reply (once/always/reject);
//   - no agent special-case: user#0 is a normal agent.
//
// Access evaluation: effective access queried via AccessResolver port
// (lineage/AccessLedger); falls back to birth value when lineage has no judgment.
//
// session exemption memo (always): subsequent asks skip dialog for that
// (agent, accessKey); never overrides deny/ignore.
//
// Injected: resolve / askRoot / getRoot / waiter / onLog.
// ============================================================

import { forget } from '../logging'
import type { LogSink } from '../logging'
import type { Waiter } from '../context/wait'
import { DefaultWaiter, waitKeys } from '../context/wait'
import type {
  AccessAssertInput,
  AccessError,
  AccessReplyInput,
  AccessRequest,
  AccessResolver,
} from './types'

export interface AccessAskOptions {
  /** Deliver access request to root agent mailbox. */
  readonly askRoot: (request: AccessRequest) => Promise<void> | void
  /** Resolve applicant lineage root (for reply authorization). */
  readonly getRoot: (agentId: string) => string
  /** Lineage access query port (kernel wires AccessLedger). */
  readonly resolve?: AccessResolver
  /** Auto-approve ask (config autoApprove). */
  readonly autoApprove?: boolean
  /** ask wait timeout ms (default infinite; cleaned by terminate/abort). */
  readonly askTimeoutMs?: number
  /** Unified wait primitive (timeout/abort/cancelOwner; default DefaultWaiter). */
  readonly waiter?: Waiter
  /** Injectable request id generator (tests). */
  readonly nextRequestId?: () => string
  /** Log sink (composition root). */
  readonly onLog?: LogSink
}

export interface AccessAskBus {
  readonly assert: (input: AccessAssertInput) => Promise<void>
  readonly reply: (input: AccessReplyInput, by: string) => Promise<void>
  readonly list: () => readonly AccessRequest[]
  readonly listApprovals: () => readonly { agentId: string; accessKey: string }[]
}

/** Exemption memo key (agent-isolated). */
function memoKey(agentId: string, accessKey: string): string {
  return agentId + '\u0000' + accessKey
}

interface AskPayload {
  readonly reply: 'once' | 'always' | 'reject'
  readonly message?: string
  readonly feedback?: string
}

export class DefaultAccessAskBus implements AccessAskBus {
  private readonly approvals = new Map<string, { agentId: string; accessKey: string }>()
  /** In-flight request info (list / reply auth); wait body lives in Waiter. */
  private readonly pending = new Map<string, AccessRequest>()
  private readonly askRoot: (request: AccessRequest) => Promise<void> | void
  private readonly getRoot: (agentId: string) => string
  private readonly resolvePort: AccessResolver | undefined
  private readonly autoApprove: boolean
  private readonly askTimeoutMs: number | undefined
  private readonly waiter: Waiter
  private readonly nextRequestId?: () => string
  private readonly onLog?: LogSink
  private counter = 0

  constructor(options: AccessAskOptions) {
    this.askRoot = options.askRoot
    this.getRoot = options.getRoot
    this.resolvePort = options.resolve
    this.autoApprove = options.autoApprove ?? false
    this.askTimeoutMs = options.askTimeoutMs
    this.waiter = options.waiter ?? new DefaultWaiter()
    this.nextRequestId = options.nextRequestId
    this.onLog = options.onLog
  }

  async assert(input: AccessAssertInput): Promise<void> {
    const action =
      this.resolvePort?.accessOf(input.agentId, input.accessKey) ?? input.birth ?? 'ask'
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
    if (this.autoApprove) return
    if (this.approvals.has(memoKey(input.agentId, input.accessKey))) return
    const info: AccessRequest = {
      id: this.nextRequestId?.() ?? 'access_' + String(++this.counter),
      accessKey: input.accessKey,
      agentId: input.agentId,
      metadata: input.metadata,
      at: Date.now(),
    }
    this.pending.set(info.id, info)
    forget(Promise.resolve(this.askRoot(info)), 'ask:askRoot', this.onLog)
    try {
      const result = await this.waiter.wait<AskPayload>({
        key: waitKeys.ask(info.id),
        owner: input.agentId,
        ...(this.askTimeoutMs !== undefined ? { timeoutMs: this.askTimeoutMs } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      })
      if (result.kind === 'event') {
        if (result.payload.reply === 'reject') {
          throw {
            kind: 'access_rejected',
            accessKey: input.accessKey,
            requestId: info.id,
            feedback: result.payload.feedback ?? result.payload.message,
          } satisfies AccessError
        }
        return
      }
      if (result.kind === 'timeout') {
        throw {
          kind: 'access_timeout',
          accessKey: input.accessKey,
          agentId: input.agentId,
          message: `等待 access_reply 超时（requestId=${info.id}）——根未在时限内答复`,
        } satisfies AccessError
      }
      throw {
        kind: 'access_aborted',
        accessKey: input.accessKey,
        agentId: input.agentId,
        message: `申请已中断（requestId=${info.id}）——发起方被 abort/终止`,
      } satisfies AccessError
    } finally {
      this.pending.delete(info.id)
    }
  }

  async reply(input: AccessReplyInput, by: string): Promise<void> {
    const info = this.pending.get(input.requestId)
    if (!info) {
      throw {
        kind: 'access_request_not_found',
        requestId: input.requestId,
        message: `无此待批申请（requestId=${input.requestId}）——可能已被答复或申请者已注销；用 telemetry 查 access.asked 事件核对在场申请`,
      } satisfies AccessError
    }
    if (by !== this.getRoot(info.agentId)) {
      throw {
        kind: 'access_reply_not_root',
        accessKey: info.accessKey,
        agentId: info.agentId,
        message: '答复权专属申请者的族谱根（一般是 user#0）——你不是根，请停止重试并等待根的答复（申请者此刻正挂起等待）',
      } satisfies AccessError
    }
    if (input.reply !== 'reject' && this.resolvePort?.accessOf(info.agentId, info.accessKey) === 'deny') {
      this.onLog?.log({
        type: 'access.replied',
        at: Date.now(),
        agentId: info.agentId,
        accessKey: info.accessKey,
        requestId: info.id,
        reply: 'reject',
      })
      this.waiter.emit(waitKeys.ask(info.id), {
        reply: 'reject',
        feedback: '该工具在申请挂起期间已被族谱权限收敛为 deny——批准不得盖过铁律',
      } satisfies AskPayload)
      return
    }
    this.onLog?.log({
      type: 'access.replied',
      at: Date.now(),
      agentId: info.agentId,
      accessKey: info.accessKey,
      requestId: info.id,
      reply: input.reply,
    })
    if (input.reply === 'always') {
      this.approvals.set(memoKey(info.agentId, info.accessKey), {
        agentId: info.agentId,
        accessKey: info.accessKey,
      })
    }
    this.waiter.emit(waitKeys.ask(info.id), {
      reply: input.reply,
      ...(input.message !== undefined ? { message: input.message } : {}),
    } satisfies AskPayload)
  }

  list(): readonly AccessRequest[] {
    return [...this.pending.values()]
  }

  listApprovals(): readonly { agentId: string; accessKey: string }[] {
    return [...this.approvals.values()]
  }
}

/**
 * Format access request message for root mailbox (with requestId for access_reply).
 */
export function formatAccessRequest(request: AccessRequest, display?: (agentId: string) => string): string {
  const meta = request.metadata ? `（${JSON.stringify(request.metadata)}）` : ''
  const who = display ? display(request.agentId) : request.agentId
  return (
    `<access_request id="${request.id}" accessKey="${request.accessKey}" agent="${who}">` +
    `agent ${who} 申请使用工具「${request.accessKey}」${meta}。` +
    `请用 access_reply 工具答复（requestId=${request.id}）。</access_request>`
  )
}
