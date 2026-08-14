// ============================================================
// core/tools/AccessManager.ts —— 工具访问确认管理器
//
// 权限模块融合进 tools 后的「执行时确认」：
//   - assert：对 kernel 合成的完整访问层（全局 → 祖先链 → agent 类）
//     追加 session 批准，分层取最严格 → allow/ignore 通过 / deny 抛错
//     / ask 挂起，发面板确认。
//   - reply：用户回复 once（通过本次）/ always（通过并写 approved）
//     / reject（拒绝，可带反馈）。
//   - 元 agent（user0，族谱树根）短路：一律 allow。
//   - 挂起用 Promise（pending Map），不依赖 effect。
//
// ignore 语义：等同 allow（能执行），只是默认隐藏（materialize 过滤）。
// ============================================================

import type { LogSink } from '../logging'
import { evaluateAccess } from './access'
import type {
  ToolAccess,
  ToolAccessRule,
  ToolAccessRules,
  AccessRequest,
  AccessReply,
  AccessReplyInput,
  AccessAssertInput,
  AccessError,
} from './types'

export interface AccessManagerOptions {
  /** 把访问确认请求交给面板（组合根注入 → PanelBus）。 */
  readonly askPanel: (request: AccessRequest) => void
  /** 日志出口（组合根注入 → core/logging）。 */
  readonly onLog?: LogSink
  /** 可注入请求 id 生成器（测试用）。 */
  readonly nextRequestId?: () => string
  /** 访问自动批准（配置 `autoApprove`）：true 时 ask 直接放行，不弹窗。 */
  readonly autoApprove?: boolean
  /**
   * 元 agent id（族谱树根，默认 'user0'）：一律 allow 短路。
   * 元 agent 作为偏序最大值，对后代零污染。
   */
  readonly metaAgentId?: string
}

export interface AccessManager {
  /** 断言访问：allow/ignore 通过 / deny 抛错 / ask 挂起等用户回复。 */
  readonly assert: (input: AccessAssertInput) => Promise<void>
  /** 用户回复（面板 → core）。 */
  readonly reply: (input: AccessReplyInput) => Promise<void>
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

export class DefaultAccessManager implements AccessManager {
  private readonly approved: ToolAccessRule[] = []
  private readonly pending = new Map<string, PendingEntry>()
  private readonly askPanel: (request: AccessRequest) => void
  private readonly onLog?: LogSink
  private readonly nextRequestId?: () => string
  private readonly autoApprove: boolean
  private readonly metaAgentId: string
  private counter = 0

  constructor(options: AccessManagerOptions) {
    this.askPanel = options.askPanel
    this.onLog = options.onLog
    this.nextRequestId = options.nextRequestId
    this.autoApprove = options.autoApprove ?? false
    this.metaAgentId = options.metaAgentId ?? 'user0'
  }

  async assert(input: AccessAssertInput): Promise<void> {
    // 元 agent（族谱树根）短路：一律 allow（用户是最终主权）。
    if (input.agentId === this.metaAgentId) return

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
    // ask：autoApprove 放行，否则挂起等面板回复。
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
      this.askPanel(info)
    })
  }

  async reply(input: AccessReplyInput): Promise<void> {
    const entry = this.pending.get(input.requestId)
    if (!entry) {
      throw { kind: 'access_request_not_found', requestId: input.requestId } satisfies AccessError
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
      entry.reject({ kind: 'access_rejected', accessKey: entry.info.accessKey, requestId: entry.info.id, feedback: input.message })
      return
    }
    if (input.reply === 'always') {
      // 用户批准优先于 agent 类规则：加入 approved，后续同访问键直接通过。
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

export type { ToolAccess, ToolAccessRule }
