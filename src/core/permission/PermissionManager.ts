// ============================================================
// core/permission/PermissionManager.ts —— 权限管理器
//
// 统一权限确认（对齐 opencode Permission service）：
//   - assert：评估规则（agent 类 + session 批准，最后命中优先）
//     → allow 通过 / deny 抛错 / ask 挂起，发面板确认。
//   - reply：用户回复 once（通过本次）/ always（通过并写 approved）
//     / reject（拒绝，可带反馈）。
//   - 挂起用 Promise（pending Map），不依赖 effect。
// ============================================================

import type { LogSink } from '../logging'
import { evaluate } from './evaluate'
import type {
  PermissionAssertInput,
  PermissionError,
  PermissionReplyInput,
  PermissionRequest,
  PermissionRules,
  PermissionRule,
} from './types'

export interface PermissionManagerOptions {
  /** 把权限请求交给面板（组合根注入 → PanelBus）。 */
  readonly askPanel: (request: PermissionRequest) => void
  /** 日志出口（组合根注入 → bus → core/logging）。 */
  readonly onLog?: LogSink
  /** 可注入请求 id 生成器（测试用）。 */
  readonly nextRequestId?: () => string
  /**
   * 全局默认权限规则（来自配置 `permission`，**最弱优先级**）。
   * 评估顺序：[globalDefaults, agent 类规则, session 批准]，最后命中优先
   * —— agent 类可覆盖全局、用户批准可覆盖 agent 类。
   */
  readonly globalDefaults?: PermissionRules
  /** 权限自动批准（配置 `autoApprove`）：true 时 ask 直接放行，不弹窗。 */
  readonly autoApprove?: boolean
}

export interface PermissionManager {
  /** 断言权限：allow 通过 / deny 抛错 / ask 挂起等用户回复。 */
  readonly assert: (input: PermissionAssertInput) => Promise<void>
  /** 用户回复（面板 → core）。 */
  readonly reply: (input: PermissionReplyInput) => Promise<void>
  /** 列出挂起中的请求。 */
  readonly list: () => readonly PermissionRequest[]
  /** session 内已批准规则（always 累积）。 */
  readonly approvedRules: () => PermissionRules
}

interface PendingEntry {
  readonly info: PermissionRequest
  readonly resolve: () => void
  readonly reject: (error: PermissionError) => void
}

export class DefaultPermissionManager implements PermissionManager {
  private readonly approved: PermissionRule[] = []
  private readonly pending = new Map<string, PendingEntry>()
  private readonly askPanel: (request: PermissionRequest) => void
  private readonly onLog?: LogSink
  private readonly nextRequestId?: () => string
  private readonly globalDefaults: PermissionRules
  private readonly autoApprove: boolean
  private counter = 0

  constructor(options: PermissionManagerOptions) {
    this.askPanel = options.askPanel
    this.onLog = options.onLog
    this.nextRequestId = options.nextRequestId
    this.globalDefaults = options.globalDefaults ?? []
    this.autoApprove = options.autoApprove ?? false
  }

  async assert(input: PermissionAssertInput): Promise<void> {
    // 规则集：[全局默认（最弱）, agent 类规则, ...session 批准（最强）]，最后命中优先。
    const action = evaluate(input.permission, [...this.globalDefaults, ...input.rules, ...this.approved])
    this.onLog?.log({
      type: 'permission.asked',
      at: Date.now(),
      agentId: input.agentId,
      permission: input.permission,
      action,
    })
    if (action === 'allow') return
    if (action === 'deny') {
      throw { kind: 'permission_denied', permission: input.permission, agentId: input.agentId } satisfies PermissionError
    }
    // ask：autoApprove 放行，否则挂起等面板回复。
    if (this.autoApprove) return
    const info: PermissionRequest = {
      id: this.nextRequestId?.() ?? `perm_${++this.counter}`,
      permission: input.permission,
      agentId: input.agentId,
      metadata: input.metadata,
      at: Date.now(),
    }
    await new Promise<void>((resolve, reject) => {
      this.pending.set(info.id, { info, resolve, reject })
      this.askPanel(info)
    })
  }

  async reply(input: PermissionReplyInput): Promise<void> {
    const entry = this.pending.get(input.requestId)
    if (!entry) {
      throw { kind: 'permission_not_found', requestId: input.requestId } satisfies PermissionError
    }
    this.pending.delete(input.requestId)
    this.onLog?.log({
      type: 'permission.replied',
      at: Date.now(),
      agentId: entry.info.agentId,
      permission: entry.info.permission,
      requestId: entry.info.id,
      reply: input.reply,
    })
    if (input.reply === 'reject') {
      entry.reject({ kind: 'permission_rejected', permission: entry.info.permission, requestId: entry.info.id, feedback: input.message })
      return
    }
    if (input.reply === 'always') {
      // 用户批准优先于 agent 类规则：加入 approved，后续同权限直接通过。
      this.approved.push({ tool: entry.info.permission, action: 'allow' })
    }
    entry.resolve()
  }

  list(): readonly PermissionRequest[] {
    return [...this.pending.values()].map((entry) => entry.info)
  }

  approvedRules(): PermissionRules {
    return [...this.approved]
  }
}
