// ============================================================
// core/kernel/Kernel.ts —— Kernel 组合根（core 内部装配）
//
// 装配：模板注册表 / 实例管理 / 空间 / 族谱树（关系 + 权限台账）
//      / 上下文仓库+管理员+快递员 / 运行时 / ask 总线 / 工具注册表。
//
// 权限模型（查询反转）：生效权限 = 族谱位置的函数——实例注册（创建/恢复）
// 时在 lineage/AccessLedger 台账物化（继承→收敛两步），tools registry /
// ask 总线经 AccessResolver 端口查询，kernel 只做接线，不再逐层拼装。
//
// 通信模型（重建邮局，无总线）：
//   - sendMessage(from, to, payload) → 管理员 deposit（打戳 + 入库 + 触发处理）；
//   - 事件（stream/letter/status/notice）统一经 events hub 发布（PilotEvent）；
//   - 访问确认（ask）消息化：投递申请到根信箱 + access_reply 工具解析（见 tools/accessRequest）。
// 参与者查询：复用 instances + user0（无独立注册表）。
// user0 是元 agent（族谱树根 parentId=null）。
// ============================================================

import type { ModelGateway } from '../gateway'
import type { LLMEvent, ModelRef, UsageEvent } from '../gateway'
import type {
  AgentDelivery,
  ContextSettings,
  MailDelivery,
  Repository,
  Courier,
  StrategyAgentSpec,
  StrategyRegistry,
} from '../context'
import { DefaultRepository, DefaultCourier, DefaultContextManager, PersistedRepository } from '../context'
import type { ContextManager, MessageStore } from '../context'
import type { Logger } from '../logging'
import { InMemoryLogger } from '../logging'
import type { LogEvent } from '../logging'
import type { AccessAskBus, AccessResolver, ToolAccess } from '../tools'
import { DefaultAccessAskBus, formatAccessRequest } from '../tools'
import type { EventHub, PilotEvent } from '../events'
import { DefaultEventHub } from '../events'
import type { ToolCapabilityRegistry, ToolContext } from '../tools'
import simpleChatTemplate from '../../../templates/SimpleChat.json'
import coderTemplate from '../../../templates/Coder.json'
import { DefaultTemplateRegistry } from './TemplateRegistry'
import type { TemplateRegistry } from './TemplateRegistry'
import { DefaultInstanceManager } from './InstanceManager'
import type { InstanceManager, InstantiateOptions } from './InstanceManager'
import { PersistedInstanceManager, PersistedSpaceManager } from './persisted'
import type { InstanceStore } from './store'
import { DefaultSpaceManager } from './SpaceManager'
import type { SpaceManager } from './SpaceManager'
import { DefaultRuntime } from './Runtime'
import type { Runtime } from './Runtime'
import { DefaultLineageTree } from '../lineage'
import type { LineageTree } from '../lineage'
import { DefaultAccessLedger } from '../lineage'
import type { AccessLedger } from '../lineage'
import { createSystemTools } from './systemTools'
import { createUserClass, USER_CLASS_ID } from './userClass'
import type { UserClassConfig } from './userClass'
import type { AgentClass, AgentClassID, AgentID, AgentInstance, AgentSpaceID, ProjectRef } from './types'
import { makeAgentClassID, makeAgentID } from './types'

/** 内置示例模板（从 templates/*.json 加载，非硬编码角色）。 */
export const BUILTIN_TEMPLATES: readonly AgentClass[] = [
  simpleChatTemplate as unknown as AgentClass,
  coderTemplate as unknown as AgentClass,
]

/** 用户面板固定 id。 */
export const USER_ID = 'user0'

export interface KernelOptions {
  readonly gateway: ModelGateway
  /** 模板未配置 model 时的默认模型。 */
  readonly defaultModel: ModelRef
  /** 覆盖内置模板（缺省用 templates/*.json）。 */
  readonly templates?: readonly AgentClass[]
  /** 工具注册表（缺省不启用工具轮）。 */
  readonly tools?: ToolCapabilityRegistry
  /** 上下文策略注册表（缺省内置 classic/none；init 管线注册 `.stem/context/` 用户策略）。 */
  readonly strategies?: StrategyRegistry
  /** 上下文策略配置（window/compact；缺省 DEFAULT_CONTEXT_SETTINGS，S3 起来自 config.context）。 */
  readonly contextSettings?: ContextSettings
  readonly defaultCountdownMs?: number
  /** 可注入倒计时实现（测试用）。 */
  readonly timer?: import('../context').TimerFactory
  readonly maxSteps?: number
  readonly estimateCost?: (usage: UsageEvent | undefined) => number
  /** 统一事件流回调（PilotEvent：stream/letter/status/notice；shell/GUI 订阅）。 */
  readonly onEvent?: (event: PilotEvent) => void
  /** 日志记录器（缺省内存版）。 */
  readonly logger?: Logger
  /**
   * user0 内嵌 agent 类配置（config.user 全对象：tools/systemPrompt/
   * sendCountdown/model/contextStrategy）；缺省 = 内置默认表（DEFAULT_USER_TOOLS）。
   */
  readonly userClass?: UserClassConfig
  /** skill 注册表（可选）：实例化 agent 时把 <available_skills> 清单注入 system 消息。 */
  readonly skills?: import('../tools').SkillRegistry
  /** 工具访问自动批准（来自配置 `autoApprove`）：ask 直接放行，不弹窗。 */
  readonly autoApprove?: boolean
  /**
   * 持久化端口（宿主注入，如 SQLite 实现）：注入后仓库/实例管理器
   * 套 write-through 装饰器（内存为准，同步落行），并在构造期恢复内存态；
   * 缺省纯内存（测试 harness 不受影响）。
   */
  readonly stateStore?: { readonly messages: MessageStore; readonly instances: InstanceStore }
}

export class Kernel {
  readonly templates: TemplateRegistry
  readonly instances: InstanceManager
  readonly spaces: SpaceManager
  /** 族谱树（无状态关系查询视图，依赖 instances 实时推导）。 */
  readonly lineage: LineageTree
  /** 上下文仓库（上下文本体的唯一存储）。 */
  readonly repository: Repository
  /** 上下文管理员（处理/打戳/组装）。 */
  readonly contextManager: ContextManager
  /** 快递员（倒计时 + 发送）。 */
  readonly courier: Courier
  readonly runtime: Runtime
  readonly tools?: ToolCapabilityRegistry
  /** 族谱权限台账（生效权限 = 族谱位置的函数；注册期物化，运行期只读查询）。 */
  readonly accessLedger: AccessLedger
  /** 访问确认（ask 消息化：投递申请到根信箱 + access_reply 解析）。 */
  readonly access: AccessAskBus
  /** 统一事件流（PilotEvent：stream/letter/status/notice；多订阅者）。 */
  readonly events: EventHub
  /** 日志记录器。 */
  readonly logger: Logger
  /** 启动期从持久化端口恢复出的实例（构造末尾接线上下文用；空 = 首启/纯内存）。 */
  private readonly restoredInstances: readonly AgentInstance[]

  constructor(options: KernelOptions) {
    this.templates = new DefaultTemplateRegistry([
      createUserClass(options.userClass),
      ...(options.templates ?? BUILTIN_TEMPLATES),
    ])

    // ---------- 持久化装配（可选 stateStore 注入，core 零平台依赖：端口由宿主实现） ----------
    // 内存核 → （注入时）同一对内存核上恢复 → 套 write-through 装饰器（恢复期不反向写）。
    // 恢复出的实例在构造末尾统一接线上下文（wireRestoredInstances）。
    const store = options.stateStore
    const memoryInstances = new DefaultInstanceManager(this.templates)
    const memoryRepository = new DefaultRepository({ onLog: (event) => this.emitLog(event) })
    const memorySpaces = new DefaultSpaceManager()
    if (store) {
      const persistedInstances = new PersistedInstanceManager(memoryInstances, store.instances)
      const persistedRepository = new PersistedRepository(memoryRepository, store.messages)
      this.restoredInstances = persistedInstances.restoreFromStore()
      persistedRepository.restoreFromStore()
      const persistedSpaces = new PersistedSpaceManager(memorySpaces, store.instances)
      persistedSpaces.restoreFromStore()
      this.instances = persistedInstances
      this.repository = persistedRepository
      this.spaces = persistedSpaces
    } else {
      this.restoredInstances = []
      this.instances = memoryInstances
      this.repository = memoryRepository
      this.spaces = memorySpaces
    }
    this.tools = options.tools
    this.logger = options.logger ?? new InMemoryLogger()

    // 统一事件流（多订阅者）：外部（shell/GUI）经 onEvent 订阅 stream/letter/status/notice。
    this.events = new DefaultEventHub()
    if (options.onEvent) this.events.subscribe(options.onEvent)

    // 族谱树（无状态视图）：实时基于 instances 推导 parent/children/ancestors。
    this.lineage = new DefaultLineageTree({
      getInstance: (id) => this.instances.getSync(id),
      getAllInstances: () => this.instances.listAllSync(),
    })

    // 族谱权限台账 + 查询端口（tools registry / ask 总线统一消费，kernel 只接线）。
    this.accessLedger = new DefaultAccessLedger()
    const accessResolver: AccessResolver = {
      accessOf: (agentId, key) => this.accessLedger.effectiveAccess(agentId, key),
    }

    // 工具访问确认（ask 消息化）：投递申请到申请者的族谱根信箱；根经 access_reply 回复。
    this.access = new DefaultAccessAskBus({
      askRoot: (request) =>
        this.contextManager.deposit(
          this.lineage.getRoot(makeAgentID(request.agentId)),
          { role: 'user', content: formatAccessRequest(request) },
          request.agentId,
        ),
      getRoot: (agentId) => this.lineage.getRoot(makeAgentID(agentId)),
      resolve: accessResolver,
      onLog: { log: (event) => this.emitLog(event) },
      autoApprove: options.autoApprove,
    })

    // 重建邮局：仓库（存储，已在持久化装配段创建）→ 管理员（策略处理 + 组装权）
    // → 快递员（只发不组装；agent 送信快照经管理员委托构造，面板 diff 自持）。
    this.courier = new DefaultCourier({
      defaultCountdownMs: options.defaultCountdownMs,
      timer: options.timer,
      repository: this.repository,
      buildAgentDelivery: (agentId) => this.contextManager.buildAgentDelivery(agentId),
      onLog: (event) => this.emitLog(event),
    })
    this.contextManager = new DefaultContextManager({
      strategies: options.strategies,
      settings: options.contextSettings,
      timer: options.timer,
      defaultCountdownMs: options.defaultCountdownMs,
      repository: this.repository,
      courier: this.courier,
      skills: options.skills,
      // 策略系统能力面（模块扮演 agent 与工具 worker 的创建/回收，kernel 执行）。
      spawnRole: (hostAgentId, role) => this.spawnRoleAgent(hostAgentId, role),
      spawnWorker: (roleAgentId, task, spec) => this.spawnStrategyWorker(roleAgentId, task, spec),
      terminateWorker: (workerId, by) => this.terminateAgent(workerId, { by }),
      onLog: (event) => this.emitLog(event),
    })
    // 仓库 onChange → 管理员处理入口。
    this.repository.onChange = (agentId) => this.contextManager.handleChange(agentId)

    this.runtime = new DefaultRuntime({
      gateway: options.gateway,
      instances: this.instances,
      templates: this.templates,
      contextManager: this.contextManager,
      repository: this.repository,
      tools: options.tools,
      defaultModel: options.defaultModel,
      maxSteps: options.maxSteps,
      estimateCost: options.estimateCost,
      onEvent: (agentId, event) => this.events.emit({ type: 'stream', agentId, event }),
      onStatus: (agentId, from, to) => this.events.emit({ type: 'status', agentId, from, to, at: Date.now() }),
      onLog: { log: (event) => this.emitLog(event) },
    })

    // 工具自动记录 → 仓库（触发/成功/失败），不依赖 runtime 手动发送。
    this.tools?.setRecordSink?.((record, ctx) => {
      void this.contextManager.appendToolRecord(ctx.agentId, record)
      if (record.status === 'success' && record.result) {
        if (record.result.metadata?.contextWait) return // context_wait：等待填充，不 append
        void this.contextManager.appendHistory(ctx.agentId, {
          role: 'tool',
          content: record.result.text,
          toolCallId: record.invocation.id,
        })
      } else if (record.status === 'error') {
        const error = record.error
        const message =
          error !== undefined && 'message' in error
            ? `[ToolError ${error.kind}] ${error.message}`
            : '[ToolError execution_failed] 工具执行失败'
        void this.contextManager.appendHistory(ctx.agentId, {
          role: 'tool',
          content: message,
          toolCallId: record.invocation.id,
        })
      }
    })
    // 工具调用日志；访问确认 → AccessAskBus；族谱权限查询 → 台账。
    this.tools?.setLogSink?.({ log: (event) => this.emitLog(event) })
    this.tools?.setAccessSink?.(this.access)
    this.tools?.setAccessResolver?.(accessResolver)

    // 恢复接线：持久化实例重新挂上管理员/快递员（跳过仓库开辟，箱已恢复）。
    this.wireRestoredInstances()
  }

  /**
   * 恢复接线（构造末尾调用一次）：为启动期恢复出的每个实例注册上下文处理
   * （restore=true：仓库箱已由 restoreFromStore 重建，只补管理员 box + 快递员注册）。
   * 根（parentId=null，即 user0）沿用 registerRootAgent 的面板接线（assemble:false + letter 事件）。
   */
  private wireRestoredInstances(): void {
    // 权限台账重放（族谱拓扑序，纯派生态不入库）。
    this.accessLedger.rebind(
      this.restoredInstances.map((instance) => ({
        agentId: instance.id as string,
        parentId: instance.parentId as string | null,
        own: this.ownAccessOf(instance.id),
      })),
    )
    for (const instance of this.restoredInstances) {
      const template = this.templates.getSync(instance.classRef)
      const isRoot = instance.parentId === null
      void this.contextManager.register({
        agentId: instance.id,
        sendCountdownMs: isRoot ? template?.sendCountdown ?? 0 : template?.sendCountdown,
        assemble: !isRoot && template?.panel !== true,
        contextStrategy: template?.contextStrategy,
        restore: this.repository.has(instance.id),
        // 面板 diff 基线：恢复箱内的全部消息 id（防重启后旧信当新信重放）。
        initialSentIds: this.repository.has(instance.id) ? this.repository.list(instance.id).map((m) => m.id) : [],
        ...(isRoot ? {} : { systemPrompt: template?.systemPrompt ?? '' }),
        onDelivery: isRoot
          ? (delivery) => {
              if (delivery.kind !== 'user') return
              this.events.emit({ type: 'letter', agentId: delivery.agentId, letters: delivery.letters, at: Date.now() })
            }
          : (delivery) => this.handleDelivery(delivery),
        ...(isRoot ? {} : { onHold: (id: string) => void this.runtime.notifyHold(makeAgentID(id)) }),
      })
    }
  }

  /** 某 agent 的自身清单（类 tools 与实例 toolOverride 合并；台账 bind 的输入，undefined = 不设限）。 */
  private ownAccessOf(agentId: AgentID): Readonly<Record<string, ToolAccess>> | undefined {
    const instance = this.instances.getSync(agentId)
    if (!instance) return undefined
    const template = this.templates.getSync(instance.classRef)
    if (template?.tools === undefined && instance.toolOverride === undefined) return undefined
    return { ...template?.tools, ...instance.toolOverride }
  }

  /** 注册根 agent（user0）：从内置 user 类实例化（parentId=null 即根，与其他实例等同）。 */
  async registerRootAgent(displayName = 'User'): Promise<AgentID> {
    const template = await this.templates.get(USER_CLASS_ID)
    const rootSpace = await this.spaces.getOrCreate(USER_ID)
    const instance = await this.instances.instantiate({
      className: USER_CLASS_ID,
      parentId: null,
      userPrompt: '',
      spaceId: rootSpace.id,
      agentId: USER_ID,
    })
    // 权限台账绑定（根：自身清单 = user 类 tools 整表，物化生效权限）。
    this.accessLedger.bind({ agentId: USER_ID, parentId: null, own: this.ownAccessOf(makeAgentID(USER_ID)) })
    this.emitLog({
      type: 'kernel.instance.created',
      at: Date.now(),
      agentId: instance.id,
      classId: instance.classRef,
      parentId: '',
    })
    if (displayName !== instance.displayName) await this.instances.takeover(makeAgentID(USER_ID), { displayName })
    await this.contextManager.register({
      agentId: USER_ID,
      systemPrompt: template.systemPrompt,
      sendCountdownMs: template.sendCountdown ?? 0,
      assemble: false,
      contextStrategy: template.contextStrategy,
      onDelivery: (delivery) => {
        if (delivery.kind !== 'user') return
        // 来信统一经事件流发布（letter 事件；含 access_request 消息化申请）。
        this.events.emit({ type: 'letter', agentId: delivery.agentId, letters: delivery.letters, at: Date.now() })
      },
    })
    return instance.id
  }

  /** 用户发送消息（默认发往当前选中的 agent）。 */
  async sendUserMessage(agentId: string, text: string): Promise<void> {
    await this.sendMessage(USER_ID, agentId, text)
  }

  /**
   * agent 间通信（无总线，直接投递到上下文管理员）。
   * from/to 为参与者 id（user0 或 agent 实例 id）。
   */
  async sendMessage(from: string, to: string, payload: string): Promise<void> {
    this.emitLog({
      type: 'kernel.message.sent',
      at: Date.now(),
      from,
      to,
      kind: 'agent_message',
      payloadSize: payload.length,
    })
    await this.contextManager.deposit(to, { role: 'user', content: payload }, from)
  }

  /** 实例化：创建实例 + 注册上下文（仓库/管理员/快递员）+ 投递首信。 */
  async instantiateAgent(opts: Omit<InstantiateOptions, 'spaceId'>, project: ProjectRef): Promise<AgentID> {
    const space = await this.spaces.getOrCreate(project)
    return this.instantiateInSpace(opts, space.id)
  }

  /** 实例化（指定空间，供系统工具 agent_instantiate / 策略 spawn 使用）。 */
  async instantiateInSpace(opts: Omit<InstantiateOptions, 'spaceId'>, spaceId: AgentSpaceID | string): Promise<AgentID> {
    const instance = await this.instances.instantiate({ ...opts, spaceId: spaceId as AgentSpaceID })
    // 权限台账绑定（注册两步曲：继承父档案 → 自身清单收敛；grant = 系统通道加法整表）。
    this.accessLedger.bind({
      agentId: instance.id as string,
      parentId: instance.parentId as string | null,
      own: this.ownAccessOf(instance.id),
      ...(opts.accessMode === 'grant' ? { mode: 'grant' as const } : {}),
    })
    this.emitLog({
      type: 'kernel.instance.created',
      at: Date.now(),
      agentId: instance.id,
      classId: instance.classRef,
      parentId: instance.parentId ?? '',
    })

    const template = await this.templates.get(instance.classRef)
    // 模块扮演面板（class panel=true：策略 role 等）：不组装、不跑 LLM 轮，
    // 信件由扮演模块消费（信箱配对 waitForReply / 审计），与 user0 面板同构。
    const isPanel = template.panel === true
    await this.contextManager.register({
      agentId: instance.id,
      systemPrompt: template.systemPrompt,
      sendCountdownMs: template.sendCountdown,
      assemble: !isPanel,
      contextStrategy: template.contextStrategy,
      onDelivery: isPanel
        ? () => {}
        : (delivery) => this.handleDelivery(delivery),
      ...(isPanel ? {} : { onHold: (id: string) => void this.runtime.notifyHold(makeAgentID(id)) }),
    })

    // 上下文传递：父 agent 指定的仓库消息 id 列表，深拷贝导入新实例上下文空间。
    if (opts.contextRefs && opts.contextRefs.length > 0 && instance.parentId) {
      const parentState = await this.contextManager.getState(instance.parentId)
      for (const ref of opts.contextRefs) {
        const stored = parentState.messages.find((m) => m.id === ref || `${m.turn}` === ref)
        if (stored && stored.message.role !== 'system') {
          await this.contextManager.appendHistory(instance.id, { ...stored.message, content: String(stored.message.content) })
        }
      }
    }

    // userPrompt 作为首封信投递（from=父，管理员打戳）；面板 role 无任务信。
    if (instance.userPrompt !== '') {
      await this.contextManager.deposit(instance.id, { role: 'user', content: instance.userPrompt }, instance.parentId ?? USER_ID)
    }
    return instance.id
  }

  /**
   * 策略扮演 agent 懒生成（模块扮演模式：pilot 扮演 user0 的同构推广）。
   * 父 = 宿主 agent（级联回收 + 族谱诚实）；grant 加法权限面；已存在则复用
   * （重启后 roleAgentId 指针丢失时按 classRef 找回，天然幂等）。
   */
  async spawnRoleAgent(hostAgentId: string, role: StrategyAgentSpec): Promise<string> {
    const host = makeAgentID(hostAgentId)
    const className = makeAgentClassID(role.className)
    const existing = this.lineage
      .getChildren(host)
      .map((id) => this.instances.getSync(id))
      .find((child) => child !== undefined && child.classRef === className)
    if (existing) return existing.id
    await this.ensureSystemTemplate(role)
    const hostInstance = this.instances.getSync(host)
    if (!hostInstance) throw { kind: 'agent_not_found', agentId: host }
    return this.instantiateInSpace({ className, parentId: host, userPrompt: '', accessMode: 'grant' }, hostInstance.spaceId)
  }

  /** 策略工具 worker 创建（父 = 扮演 agent；任务 = userPrompt 首信；回收交调用方）。 */
  async spawnStrategyWorker(roleAgentId: string, task: string, spec: StrategyAgentSpec): Promise<string> {
    const role = makeAgentID(roleAgentId)
    await this.ensureSystemTemplate(spec)
    const roleInstance = this.instances.getSync(role)
    if (!roleInstance) throw { kind: 'agent_not_found', agentId: role }
    return this.instantiateInSpace(
      { className: makeAgentClassID(spec.className), parentId: role, userPrompt: task, accessMode: 'grant' },
      roleInstance.spaceId,
    )
  }

  /** 策略声明的系统模板 ensure（幂等；策略硬编码自身人设——决策 C）。 */
  private async ensureSystemTemplate(spec: StrategyAgentSpec): Promise<void> {
    const name = makeAgentClassID(spec.className)
    if (this.templates.getSync(name)) return
    await this.templates.register({
      name,
      description: spec.description,
      systemPrompt: spec.systemPrompt,
      tools: spec.tools ?? {},
      sendCountdown: spec.sendCountdown ?? 0,
      contextStrategy: spec.contextStrategy ?? 'none',
      ...(spec.panel !== undefined ? { panel: spec.panel } : {}),
      ...(spec.model !== undefined ? { model: spec.model } : {}),
    })
    this.emitLog({ type: 'kernel.class.registered', at: Date.now(), classId: spec.className })
  }

  /** 注册系统管理工具（agent_ 与 bus_ 前缀）到工具注册表。 */
  async registerSystemTools(registry: ToolCapabilityRegistry): Promise<void> {
    for (const tool of createSystemTools(this)) {
      await registry.register(tool)
    }
  }

  /**
   * 终止实例：销毁权校验（by 是祖先，实例管理器内 fail-fast）→ 实例删除
   * （含 recursive 级联）→ 逐个注销上下文（仓库行经装饰器归档）。
   * 顺序保证：校验先于一切副作用（原实现先注销目标上下文再校验，抛出时上下文已丢）。
   */
  async terminateAgent(agentId: string, opts?: { by?: string; recursive?: boolean }): Promise<void> {
    const target = makeAgentID(agentId)
    const subtree = [target, ...this.lineage.getDescendants(target)]
    await this.instances.terminate(target, {
      by: makeAgentID(opts?.by ?? USER_ID),
      recursive: opts?.recursive,
    })
    for (const id of subtree) {
      await this.contextManager.unregister(id)
      this.accessLedger.unbind(id)
    }
    this.emitLog({ type: 'kernel.instance.terminated', at: Date.now(), agentId })
  }

  /**
   * 中断指定 agent 的当前轮（仅暂停，不销毁；消息闭合后可恢复）。
   * 中断权与销毁权同源：自身或祖先（根为全树祖先，天然有权；无 agent 特判）。
   */
  async interruptAgent(agentId: string, opts?: { by?: string }): Promise<void> {
    const by = makeAgentID(opts?.by ?? USER_ID)
    const target = makeAgentID(agentId)
    if (by !== target && !this.lineage.isAncestorOf(by, target)) {
      throw { kind: 'agent_terminate_denied', agentId: target, by: by as string }
    }
    this.runtime.abort(target)
  }

  /** 中断所有活跃 agent（进程优雅收尾用）。 */
  abortAllAgents(): void {
    this.runtime.abortAll()
  }

  /** 当前活跃（thinking/进行中）的 agent id 列表。 */
  activeAgents(): readonly AgentID[] {
    return this.runtime.activeAgents()
  }

  /** Scheduler 最小直通：空间内已存在该模板实例则复用，否则创建。 */
  async getOrCreateAgent(
    className: AgentClassID,
    project: ProjectRef,
    opts?: { userPrompt?: string },
  ): Promise<AgentID> {
    const space = await this.spaces.getOrCreate(project)
    const existing = await this.instances.listBySpace(space.id)
    const found = existing.find((agent) => agent.classRef === className)
    if (found) return found.id
    return this.instantiateAgent(
      {
        className,
        parentId: makeAgentID(USER_ID),
        userPrompt: opts?.userPrompt ?? '你好，请做一个简短的自我介绍。',
      },
      project,
    )
  }

  /** 空间内实例列表。 */
  async listAgentsBySpace(spaceId: AgentSpaceID): Promise<AgentID[]> {
    const agents = await this.instances.listBySpace(spaceId)
    return agents.map((agent) => agent.id)
  }

  /**
   * 导出某 agent 的完整上下文（jsonl）。薄转发到 context 模块（纯格式化）。
   * 供宿主调试/审计；作为系统工具时由 Kernel 做权限校验（agent 只能看自己的）。
   */
  async exportContext(agentId: string): Promise<string> {
    return this.contextManager.exportJsonl(agentId)
  }

  /**
   * 上下文概览（只读反射）。薄转发到 context 模块（纯格式化）。
   * 通用能力，不依赖任何特定上下文策略。
   */
  async contextOverview(agentId: string): Promise<string> {
    return this.contextManager.overview(agentId)
  }

  /** 参与者列表（复用实例 + user0，无独立注册表）。 */
  async listParticipants(): Promise<string[]> {
    const spaces = await this.spaces.list()
    const ids: string[] = [USER_ID]
    for (const space of spaces) {
      const agents = await this.instances.listBySpace(space.id)
      ids.push(...agents.map((a) => a.id))
    }
    return ids
  }

  private handleDelivery(delivery: MailDelivery): void {
    if (delivery.kind === 'agent') {
      void this.runtime.processDelivery(delivery)
    }
  }

  /** 注册新 agent 类（供系统工具 agent_class_create 使用，含日志）。 */
  async registerAgentClass(cls: AgentClass): Promise<void> {
    await this.templates.register(cls)
    this.emitLog({ type: 'kernel.class.registered', at: Date.now(), classId: cls.name })
  }

  /** 发送日志事件（直接写入日志记录器，无总线中转）。 */
  private emitLog(event: LogEvent): void {
    this.logger.log(event)
  }
}
