// ============================================================
// core/context/ContextManager.ts —— 管理员子模块（上下文处理）
//
// 职责（重建邮局的逻辑层）：
//   - 收到「上下文待处理事件」（仓库 onChange）→ 处理该 agent：
//       1. context_wait 判定：from 命中挂起等待 → 作为 tool 结果填充到 owner；
//       2. 打发送者戳：user 消息累积时用 from 元数据生成 `<sender id=...>`；
//       3. **策略处理（process，异步）**：user_prompt 信件抵达触发，
//          返回 = 完整上下文就绪 → 才提醒快递员（classic 的 compact 在此）；
//       4. 组装（策略 assemble 纯函数 + legalize）→ 送信快照；
//   - 组装权归管理员（快递员只发不组装——策略对真实送信生效的前提）；
//   - 信箱配对（waitForReply）：模块扮演 agent 的程序化等待原语
//    （策略 spawn worker 的回信兑现点）；
//   - 策略专有动作入口（runStrategyAction ← pilot / context_apply）。
//
// 存储交给仓库（Repository），发送交给快递员（Courier），
// 造 agent（role/worker）经 kernel 注入回调（策略的系统能力面）。
// ============================================================

import type { ChatMessage } from '../gateway'
import type { LogEvent } from '../logging'
import type { ToolRecord } from '../tools'
import type { Courier, CourierRegistration, TimerFactory } from './Courier'
import type { Repository } from './Repository'
import type { AgentDelivery, AssembleInput, AssembleResult, MailDelivery, RepositoryState } from './types'
import { legalize } from './legalize'
import type { ContextStrategyModule, StrategyApi, StrategyAgentSpec, ContextSettings, StrategyRegistry } from './strategies'
import { forget } from '../logging'
import { createBuiltinStrategyRegistry, DEFAULT_CONTEXT_SETTINGS } from './strategies'

export interface ContextManagerOptions {
  /** 策略注册表（缺省内置 classic/none；init 管线可注册 `.stem/context/` 用户策略）。 */
  readonly strategies?: StrategyRegistry
  /** 上下文策略配置（window/compact 阈值等；缺省 DEFAULT_CONTEXT_SETTINGS）。 */
  readonly settings?: ContextSettings
  /** 可注入计时器（回信配对超时；缺省 setTimeout）。 */
  readonly timer?: TimerFactory
  readonly defaultCountdownMs?: number
  /** 仓库（组合根注入）。 */
  readonly repository: Repository
  /** 快递员（组合根注入）。 */
  readonly courier: Courier
  /** 创建策略扮演 agent（kernel 接线：grant + panel 模板 ensure + 实例化；父 = 宿主）。 */
  readonly spawnRole?: (hostAgentId: string, role: StrategyAgentSpec) => Promise<string>
  /** 创建策略工具 worker（kernel 接线：grant + instantiate；任务 = userPrompt 首信）。 */
  readonly spawnWorker?: (roleAgentId: string, task: string, spec: StrategyAgentSpec) => Promise<string>
  /** 回收策略工具 worker（kernel 接线：terminate → 消息归档保语料）。 */
  readonly terminateWorker?: (workerId: string, by: string) => Promise<void>
  /** 日志出口（组合根注入 → core/logging）。 */
  readonly onLog?: (event: LogEvent) => void
}

/** 实例化时注册（成分信息 + 送信回调）。 */
export interface ContextRegistration {
  readonly agentId: string
  readonly systemPrompt?: string
  readonly sendCountdownMs?: number
  /** false = 用户面板（user0/策略扮演 agent：不组装只汇总）。 */
  readonly assemble?: boolean
  /** 上下文管理策略名（缺省 = 注册表 default 'classic'；未知 → 注册期报错）。 */
  readonly contextStrategy?: string
  /** 送信回调（agent → kernel；user/扮演面板 → 模块/面板）。 */
  readonly onDelivery: (delivery: MailDelivery) => void
  /** 倒计时结束但无信可送时调用（agent → 进入 hold）。 */
  readonly onHold?: (agentId: string) => void
  /**
   * true = 持久化恢复接线：跳过仓库开辟（消息箱已由恢复流程重建，
   * system 行本身在恢复的消息里），只补管理员 box + 快递员注册。
   */
  readonly restore?: boolean
  /** 恢复接线：快递员已发送 id 预置（防面板重放旧信）。 */
  readonly initialSentIds?: readonly string[]
}

interface InternalBox {
  readonly agentId: string
  readonly assemble: boolean
  /** 该 agent 的上下文策略模块（开辟时确定——上下文属性）。 */
  readonly strategy: ContextStrategyModule
  /** 挂起等待：waitFor agent id → 挂起记录。 */
  readonly pendingFills: Map<string, { waitFor: string; ownerId: string; toolCallId: string }>
  /** 信箱配对：发件人 id → 回信兑现器（waitForReply 注册）。 */
  readonly waitPromises: Map<string, (text: string) => void>
  /** 策略处理中（重入 guard：处理期间的来信合并为一次补跑）。 */
  processing: boolean
  processDirty: boolean
  /** 该策略的扮演 agent（懒生成；spawn worker 的父与回信收集点）。 */
  roleAgentId: string | undefined
  /** 各成分最近就绪时间（毫秒，供日志）。 */
  lastLetterAt: number | undefined
  lastHistoryAt: number | undefined
  lastToolAt: number | undefined
}

export interface ContextManager {
  readonly register: (registration: ContextRegistration) => Promise<void>
  readonly unregister: (agentId: string) => Promise<void>
  /**
   * 投信（from 为发送者 id，用于打戳与 context_wait 分流）。
   * 命中挂起等待 → tool 结果填充；user_prompt 抵达 → 触发策略 process，
   * 完整上下文就绪后才提醒快递员。
   */
  readonly deposit: (agentId: string, letter: ChatMessage, from?: string) => Promise<void>
  /** 注册挂起等待：等待 waitFor 的回复作为 tool 结果填充到 owner 上下文。 */
  readonly registerHold: (waitFor: string, opts: { ownerId: string; toolCallId: string }) => Promise<void>
  /** 追加历史（runtime 复制 assistant；工具模块注入 tool 结果）。opts.tag 标记合成消息，opts.tokens 真实计量直记（缺省估算）。 */
  readonly appendHistory: (
    agentId: string,
    message: ChatMessage,
    opts?: { readonly tag?: string; readonly tokens?: number },
  ) => Promise<void>
  /**
   * 真实 token 计量归位（T3 累积差分法）：每 LLM 请求 usage 抵达时调用——
   * assistant 行由 appendHistory 直记 output；本方法把「相邻请求 input 差分」
   * 按估算占比归位到两轮之间新入库的 tool/user 行（真实口径覆盖估算）。
   * 差分非正（compact 重组/组装跳变）→ 该批回落估算，基线照常推进（自愈）。
   * 基线纯内存（重启后首轮重记），compact 天然重置。
   */
  readonly attributeUsage: (agentId: string, usage: { readonly inputTokens: number; readonly outputTokens: number }) => Promise<void>
  /** 工具调用审计记录（工具模块自动发送）。 */
  readonly appendToolRecord: (agentId: string, record: ToolRecord) => Promise<void>
  readonly getState: (agentId: string) => Promise<RepositoryState>
  /** 底层仓库（供 kernel/工具读取）。 */
  readonly repository: Repository
  /** 策略注册表（pilot/init 注册用户策略；内核构造默认内置两枚）。 */
  readonly strategies: StrategyRegistry
  /**
   * 构造 agent 送信快照（策略 assemble + legalize 的正规出口）。
   * 快递员 deliver 时经委托回调调用——组装权归管理员（策略对真实送信生效）。
   */
  readonly buildAgentDelivery: (agentId: string) => AgentDelivery | undefined
  /**
   * 信箱配对：等待 target 收到 from 的来信（resolve 文本；超时 reject）。
   * 消息本体照常入库（审计留痕）——配对只是额外兑现。
   */
  readonly waitForReply: (targetId: string, fromId: string, timeoutMs: number) => Promise<string>
  /** 执行策略专有动作（context_apply / pilot / CLI 通道；如 classic compact）。 */
  readonly runStrategyAction: (agentId: string, action: string, args?: string) => Promise<string>
  /** 仓库 onChange 处理入口（组合根装配时注入给仓库）。 */
  readonly handleChange: (agentId: string) => void
  /**
   * 导出完整上下文为 jsonl（逐行 JSON，含 tag/turn/indexInTurn）。
   * 纯数据转换，无权限概念（权限由 Kernel 层编排）。
   */
  readonly exportJsonl: (agentId: string) => Promise<string>
  /**
   * 上下文概览（只读反射）：每条消息的 role / turn / tag / token 占比 / 索引。
   * 纯数据转换，无权限概念。
   */
  readonly overview: (agentId: string) => Promise<string>
}

export class DefaultContextManager implements ContextManager {
  readonly repository: Repository
  readonly strategies: StrategyRegistry
  private readonly settings: ContextSettings
  private readonly timer: TimerFactory
  private readonly boxes = new Map<string, InternalBox>()
  private readonly courier: Courier
  /** token 差分归位基线（agentId → 上次请求 usage + 水位；纯内存，重启/compact 自愈）。 */
  private readonly tokenBases = new Map<string, { input: number; output: number; count: number }>()
  private readonly spawnRole?: (hostAgentId: string, role: StrategyAgentSpec) => Promise<string>
  private readonly spawnWorker?: (roleAgentId: string, task: string, spec: StrategyAgentSpec) => Promise<string>
  private readonly terminateWorker?: (workerId: string, by: string) => Promise<void>
  private readonly onLog?: (event: LogEvent) => void

  constructor(options: ContextManagerOptions) {
    this.strategies = options.strategies ?? createBuiltinStrategyRegistry()
    this.settings = options.settings ?? DEFAULT_CONTEXT_SETTINGS
    this.timer = options.timer ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms)
      return { cancel: () => clearTimeout(handle) }
    })
    this.repository = options.repository
    this.courier = options.courier
    this.spawnRole = options.spawnRole
    this.spawnWorker = options.spawnWorker
    this.terminateWorker = options.terminateWorker
    this.onLog = options.onLog
  }

  async register(registration: ContextRegistration): Promise<void> {
    if (this.boxes.has(registration.agentId)) {
      throw { kind: 'mailbox_conflict', agentId: registration.agentId }
    }
    // 策略解析（开辟上下文空间时确定——上下文属性）：
    // 面板（user0 / 模块扮演 role：不组装不处理）恒用 none——策略 note 不污染人格
    // systemPrompt；未知策略名注册期 fail-fast；恢复接线兜底默认策略
    //（策略文件被删不炸启动）。
    let strategy: ContextStrategyModule | undefined
    if (registration.assemble === false) {
      strategy = this.strategies.resolve('none') ?? this.strategies.resolve(undefined)
    } else {
      strategy = this.strategies.resolve(registration.contextStrategy)
      if (!strategy && registration.restore === true) {
        strategy = this.strategies.resolve(undefined)
      }
    }
    if (!strategy) {
      throw { kind: 'context_strategy_unknown', agentId: registration.agentId, strategy: registration.contextStrategy ?? '' }
    }

    const box: InternalBox = {
      agentId: registration.agentId,
      assemble: registration.assemble ?? true,
      strategy,
      pendingFills: new Map(),
      waitPromises: new Map(),
      processing: false,
      processDirty: false,
      roleAgentId: undefined,
      lastLetterAt: undefined,
      lastHistoryAt: undefined,
      lastToolAt: undefined,
    }
    this.boxes.set(registration.agentId, box)

    // 恢复接线跳过仓库开辟（箱已存在，system 行在恢复消息里）；新注册正常开辟。
    if (registration.restore !== true) {
      const base = registration.systemPrompt ?? ''
      const parts = [base, strategy.note ?? ''].filter((part) => part !== '')
      await this.repository.register(registration.agentId, parts.join('\n\n'))
    }

    // 快递员注册。
    const courierRegistration: CourierRegistration = {
      agentId: registration.agentId,
      sendCountdownMs: registration.sendCountdownMs,
      onDelivery: registration.onDelivery,
      onHold: registration.onHold,
      assemble: registration.assemble,
      initialSentIds: registration.initialSentIds,
    }
    await this.courier.register(courierRegistration)
  }

  async unregister(agentId: string): Promise<void> {
    const box = this.boxes.get(agentId)
    await this.courier.unregister(agentId)
    await this.repository.unregister(agentId)
    if (box) {
      // 兑现全部等待（空文本 = 调用方按"未产出"处理，不悬挂）。
      for (const waiter of box.waitPromises.values()) waiter('')
      box.waitPromises.clear()
    }
    this.boxes.delete(agentId)
  }

  async registerHold(waitFor: string, opts: { ownerId: string; toolCallId: string }): Promise<void> {
    const box = this.require(opts.ownerId)
    box.pendingFills.set(waitFor, { waitFor, ownerId: opts.ownerId, toolCallId: opts.toolCallId })
  }

  async deposit(agentId: string, letter: ChatMessage, from?: string): Promise<void> {
    // context_wait 分流：发送者命中挂起等待 → 该回复作为 tool 结果填充（非信件）。
    // （轮内填充不触发策略 process——触发点是 user_prompt 信件。）
    if (from !== undefined) {
      const pending = this.findPendingFor(from)
      if (pending) {
        const owner = this.require(pending.ownerId)
        owner.pendingFills.delete(from)
        owner.lastHistoryAt = Date.now()
        await this.repository.append(pending.ownerId, {
          message: { role: 'tool', content: letter.content, toolCallId: pending.toolCallId },
        })
        // 唤醒等待者（context_wait 填充就绪 → 快递员送信）。
        forget(this.courier.notifyReady(pending.ownerId), 'cm:notifyReady:fill', this.onLog)
        return
      }
    }
    const box = this.require(agentId)
    box.lastLetterAt = Date.now()
    // 先入库（含 from），管理员处理时统一打戳。
    await this.repository.append(agentId, { message: letter, from })
    // 信箱配对：命中等待 → 兑现（消息本体已入库留痕）。
    if (from !== undefined) {
      const waiter = box.waitPromises.get(from)
      if (waiter !== undefined) {
        box.waitPromises.delete(from)
        waiter(typeof letter.content === 'string' ? letter.content : JSON.stringify(letter.content))
      }
    }
    // 触发点 = user_prompt 信件抵达：策略 process（异步许可）→ 就绪 → 提醒快递员。
    await this.wake(box)
  }

  async appendHistory(
    agentId: string,
    message: ChatMessage,
    opts?: { readonly tag?: string; readonly tokens?: number },
  ): Promise<void> {
    const box = this.require(agentId)
    box.lastHistoryAt = Date.now()
    await this.repository.append(agentId, {
      message,
      ...(opts?.tag !== undefined ? { tag: opts.tag } : {}),
      ...(opts?.tokens !== undefined ? { tokens: opts.tokens } : {}),
    })
  }

  async attributeUsage(
    agentId: string,
    usage: { readonly inputTokens: number; readonly outputTokens: number },
  ): Promise<void> {
    this.require(agentId)
    const messages = this.repository.list(agentId)
    const base = this.tokenBases.get(agentId)
    if (base === undefined) {
      // 首轮只记基线：整段 prompt（含 schemas）无行级可分性，估算保留。
      this.tokenBases.set(agentId, { input: usage.inputTokens, output: usage.outputTokens, count: messages.length })
      return
    }
    // 相邻请求差分：Δ = input(n) - input(n-1) - output(n-1) = 两轮间新行（tool/user）的真实增量。
    const delta = usage.inputTokens - base.input - base.output
    if (delta > 0) {
      // assistant 行已在 append 时直记 output（过滤之）；批次 = 基线水位后新行。
      const candidates = messages.slice(base.count).filter((m) => m.message.role !== 'assistant')
      const estSum = candidates.reduce((sum, m) => sum + m.tokens, 0)
      if (candidates.length > 0 && estSum > 0) {
        let assigned = 0
        for (let i = 0; i < candidates.length; i++) {
          const candidate = candidates[i]!
          const share =
            i === candidates.length - 1
              ? Math.max(1, delta - assigned) // 末行吸收凑整误差
              : Math.max(1, Math.round(delta * (candidate.tokens / estSum)))
          assigned += share
          await this.repository.setTokens(agentId, candidate.id, share)
        }
      }
    }
    // delta ≤ 0（compact 重组等跳变）→ 该批回落估算；基线照常推进，下轮自愈。
    this.tokenBases.set(agentId, { input: usage.inputTokens, output: usage.outputTokens, count: messages.length })
  }

  async appendToolRecord(agentId: string, record: ToolRecord): Promise<void> {
    const box = this.require(agentId)
    box.lastToolAt = Date.now()
    // 工具审计记录仅占位（工具调用日志由工具模块经 LogSink 上报，见 Kernel 装配）。
  }

  async getState(agentId: string): Promise<RepositoryState> {
    return this.repository.getState(agentId)
  }

  buildAgentDelivery(agentId: string): AgentDelivery | undefined {
    const box = this.boxes.get(agentId)
    if (!box || !box.assemble) return undefined
    const valid = this.repository.listValid(agentId)
    if (valid.length === 0) return undefined
    const assembled = box.strategy.assemble({ agentId, messages: valid } as AssembleInput)
    return {
      kind: 'agent',
      agentId,
      system: assembled.system,
      messages: legalize(assembled.messages),
      messageIds: assembled.messageIds,
    }
  }

  async waitForReply(targetId: string, fromId: string, timeoutMs: number): Promise<string> {
    const box = this.require(targetId)
    return new Promise<string>((resolve, reject) => {
      const timer = this.timer(() => {
        box.waitPromises.delete(fromId)
        reject({ kind: 'context_reply_timeout', targetId, fromId })
      }, timeoutMs)
      box.waitPromises.set(fromId, (text) => {
        timer.cancel()
        resolve(text)
      })
    })
  }

  async runStrategyAction(agentId: string, action: string, args = ''): Promise<string> {
    const box = this.require(agentId)
    const fn = box.strategy.actions?.[action]
    if (!fn) {
      throw { kind: 'context_action_unknown', agentId, action, known: Object.keys(box.strategy.actions ?? {}).join(',') }
    }
    return fn(this.apiFor(box), args)
  }

  async exportJsonl(agentId: string): Promise<string> {
    const state = await this.repository.getState(agentId)
    return state.messages
      .map((m) =>
        JSON.stringify({
          id: m.id,
          role: m.message.role,
          content: String(m.message.content),
          at: m.at,
          tokens: m.tokens,
          valid: m.valid,
          ...(m.from !== undefined ? { from: m.from } : {}),
          ...(m.tag !== undefined ? { tag: m.tag } : {}),
          turn: m.turn,
          indexInTurn: m.indexInTurn,
        }),
      )
      .join('\n')
  }

  async overview(agentId: string): Promise<string> {
    const state = await this.repository.getState(agentId)
    const total = state.messages.reduce((sum, m) => sum + m.tokens, 0) || 1
    const lines = state.messages.map((m) => {
      const pct = ((m.tokens / total) * 100).toFixed(1)
      const content = String(m.message.content)
      return `[${m.turn}:${m.indexInTurn}] ${m.message.role}${m.tag !== undefined ? ` <${m.tag}>` : ''} ${m.tokens}tok(${pct}%) ${content.slice(0, 60)}${content.length > 60 ? '…' : ''}`
    })
    return `上下文概览 ${agentId}（${state.messages.length} 条，${total} tok）:\n${lines.join('\n')}`
  }

  /** 仓库 onChange 入口：打戳 + 组装快照（供日志）。唤醒快递员由 deposit 策略链负责。 */
  readonly handleChange: (agentId: string) => void = (agentId) => {
    const box = this.boxes.get(agentId)
    if (!box) return
    // 1. 打发送者戳（把所有未打戳的 user 消息补上戳）。
    this.applyStamps(box)
    // 2. 组装快照（供日志；agent = 策略送信快照，user/扮演面板 = 信件汇总）。
    const readyAt = { letters: box.lastLetterAt, history: box.lastHistoryAt, tools: box.lastToolAt }
    if (box.assemble) {
      const delivery = this.buildAgentDelivery(agentId)
      if (delivery === undefined) return
      this.onLog?.({
        type: 'context.assembled',
        at: Date.now(),
        agentId,
        assemble: true,
        messageCount: delivery.messageIds.length,
        messages: [{ role: 'system', content: delivery.system }, ...delivery.messages],
        readyAt,
      })
      return
    }
    const letters = this.repository
      .listValid(agentId)
      .filter((m) => m.message.role === 'user')
      .map((m) => m.message)
    if (letters.length === 0) return
    this.onLog?.({
      type: 'context.assembled',
      at: Date.now(),
      agentId,
      assemble: false,
      messageCount: letters.length,
      messages: legalize(letters),
      readyAt,
    })
  }

  /**
   * 来信唤醒（触发点语义）：
   * 无 process 的策略 / 面板 → 直接提醒快递员；
   * 有 process → 处理完成（或重入合并补跑完成）才提醒；失败兜底照常唤醒（绝不卡死）。
   */
  private async wake(box: InternalBox): Promise<void> {
    if (!box.assemble || box.strategy.process === undefined) {
      forget(this.courier.notifyReady(box.agentId), 'cm:notifyReady', this.onLog)
      return
    }
    if (box.processing) {
      box.processDirty = true
      return
    }
    box.processing = true
    try {
      do {
        box.processDirty = false
        await box.strategy.process(this.apiFor(box))
      } while (box.processDirty)
    } catch (cause) {
      // 双保险（compact 内部已 catch）：策略异常只留日志，不阻塞送信。
      this.onLog?.({
        type: 'context.compacted',
        at: Date.now(),
        agentId: box.agentId,
        outcome: 'failed',
        compactedCount: 0,
        message: `策略处理异常：${cause instanceof Error ? cause.message : JSON.stringify(cause)}`,
      })
    } finally {
      box.processing = false
    }
    forget(this.courier.notifyReady(box.agentId), 'cm:notifyReady', this.onLog)
  }

  /** 构造策略运行时 API（agent 作用域）。 */
  private apiFor(box: InternalBox): StrategyApi {
    return {
      agentId: box.agentId,
      settings: this.settings,
      estimatedTokens: () => this.repository.listValid(box.agentId).reduce((sum, m) => sum + m.tokens, 0),
      list: () => this.repository.list(box.agentId),
      listValid: () => this.repository.listValid(box.agentId),
      append: async (message, tag) => {
        await this.appendHistory(box.agentId, message, tag === undefined ? undefined : { tag })
      },
      markInvalid: async (ids) => {
        await this.repository.markInvalid(box.agentId, ids)
      },
      spawn: async (task, spec) => {
        if (!this.spawnWorker || !this.terminateWorker) {
          throw { kind: 'strategy_spawn_unavailable', agentId: box.agentId }
        }
        if (box.roleAgentId === undefined) {
          const role = box.strategy.role
          if (role === undefined || !this.spawnRole) {
            throw { kind: 'strategy_role_unavailable', agentId: box.agentId }
          }
          box.roleAgentId = await this.spawnRole(box.agentId, role)
        }
        const workerId = await this.spawnWorker(box.roleAgentId, task, spec)
        try {
          return await this.waitForReply(box.roleAgentId, workerId, this.settings.compact.replyTimeoutMs)
        } finally {
          // 回收：worker 任务完成即销毁（消息归档保语料，进化素材不丢）。
          await this.terminateWorker(workerId, box.roleAgentId)
        }
      },
      log: (event) => {
        this.onLog?.({ ...event, at: Date.now() } as LogEvent)
      },
    }
  }

  /** 把所有未打戳的 user 消息（含 from）补上发送者戳。 */
  private applyStamps(box: InternalBox): void {
    const valid = this.repository.listValid(box.agentId)
    for (const stored of valid) {
      if (stored.from === undefined || stored.message.role !== 'user') continue
      const text = contentOf(stored.message)
      if (text.startsWith('<sender id=')) continue // 已打戳
      const stamped: ChatMessage = { role: 'user', content: `<sender id="${stored.from}">${text}</sender>` }
      forget(this.repository.updateMessage(box.agentId, stored.id, stamped), 'cm:stamp', this.onLog)
    }
  }

  private findPendingFor(senderId: string): { ownerId: string; toolCallId: string } | undefined {
    for (const box of this.boxes.values()) {
      const pending = box.pendingFills.get(senderId)
      if (pending) return pending
    }
    return undefined
  }

  private require(agentId: string): InternalBox {
    const box = this.boxes.get(agentId)
    if (!box) throw { kind: 'mailbox_not_found', agentId }
    return box
  }
}

function contentOf(message: ChatMessage): string {
  return typeof message.content === 'string' ? message.content : ''
}
