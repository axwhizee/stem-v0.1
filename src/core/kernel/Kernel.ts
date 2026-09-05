// ============================================================
// core/kernel/Kernel.ts —— Kernel 组合根（core 内部装配）
//
// 装配：模板注册表 / 实例管理 / 空间 / 族谱树（拓扑 + 能力 + 可见域门面）
//      / 上下文仓库+管理员+快递员 / 运行时 / ask 总线 / 工具注册表。
//
// 权限模型（查询反转）：生效权限 = 族谱位置的函数——实例注册（创建/恢复）
// 时经 lineage.attach/replay 在族谱树内物化（继承→收敛两步，S5.1 起台账
// 并入树门面），tools registry / ask 总线经 AccessResolver 端口查询，
// kernel 只做接线，不再逐层拼装。
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
  StrategyRegistry,
} from '../context'
import { DefaultRepository, DefaultCourier, DefaultContextManager, PersistedRepository } from '../context'
import type { ContextManager, MessageStore } from '../context'
import type { Logger } from '../logging'
import { forget, InMemoryLogger } from '../logging'
import type { LogEvent } from '../logging'
import type { AccessAskBus, AccessResolver, ToolAccess } from '../tools'
import { DefaultAccessAskBus, formatAccessRequest, checkToolsConvergence } from '../tools'
import type { EventHub, PilotEvent } from '../events'
import { DefaultEventHub } from '../events'

/** agent_update 统一通道入参（tools 两形式互斥；语义见 updateAgent）。 */
export interface AgentUpdateSpec {
  readonly agentId: string
  /** 发起者；缺省 = 跳过可见域判定（pilot 信任通道）。 */
  readonly by?: string
  readonly displayName?: string
  readonly model?: ModelRef
  /** 收敛 patch：提及键合并，逐键对现自身清单只许收敛。 */
  readonly toolsPatch?: Readonly<Record<string, ToolAccess>>
  /** 清单形整表替换：未列一律 deny，逐键经祖先显式封顶。与 toolsPatch 互斥。 */
  readonly toolsGrant?: Readonly<Record<string, ToolAccess>>
}

import type { ToolCapabilityRegistry, ToolContext } from '../tools'
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
import { createSystemTools } from './systemTools'
import { ASSISTANT, buildUserClass } from './builtin/agents'
import type { UserClassConfig } from './builtin/agents'
import type { AgentClass, AgentClassID, AgentID, AgentInstance, AgentInstancePatch, AgentSpaceID, ProjectRef } from './types'
import { makeAgentClassID, makeAgentID, USER_CLASS_ID } from './types'

/**
 * 内置模板（S9 类形态统一：唯一定义域 `kernel/builtin/agents.ts`）。
 * = assistant 占位类（tools 不写 = 完整继承父档案，模型落四级解析链——
 * internal 保底一张白纸）；user 类不在内（config 驱动，构造期 buildUserClass 装配）。
 */
export const BUILTIN_TEMPLATES: readonly AgentClass[] = [ASSISTANT]

/** 用户面板固定 id。 */
export const USER_ID = 'user0'

export interface KernelOptions {
  readonly gateway: ModelGateway
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
  /** 工具访问自动批准（来自配置 `autoApprove`）：ask 直接放行，不弹窗。 */
  readonly autoApprove?: boolean
  /**
   * 持久化端口（宿主注入，如 SQLite 实现）：注入后仓库/实例管理器
   * 套 write-through 装饰器（内存为准，同步落行），并在构造期恢复内存态；
   * 缺省纯内存（测试 harness 不受影响）。
   */
  readonly stateStore?: { readonly messages: MessageStore; readonly instances: InstanceStore }
  /**
   * 类回写端口（S5.2 进化书写面，宿主注入：serialize → `.stem/agent/*.md`）。
   * agent_class_create/update 的 persist 请求经此落盘（目录即真相：重启由
   * runInit 扫描装载，进化跨重启生效）；缺省 = 仅内存注册（试验田语义）。
   */
  readonly classStore?: ClassStore
  /**
   * 项目空间身份（S6/R3/R11：`.stem` = 世界，一进程一空间）。
   * 根（user0）挂此空间（废除伪 space 行）；缺省 = 匿名单空间（纯内存/测试）。
   */
  readonly project?: ProjectRef
}

/** 类回写端口（写侧序列化在 core，文件 IO 由宿主实现——零平台依赖不破）。 */
export interface ClassStore {
  readonly save: (cls: AgentClass) => Promise<void>
}

export class Kernel {
  readonly templates: TemplateRegistry
  readonly instances: InstanceManager
  readonly spaces: SpaceManager
  /** 族谱树门面（拓扑实时推导 + 能力物化 + 可见域；S5.1 起台账并入）。 */
  readonly lineage: LineageTree
  /** 上下文仓库（上下文本体的唯一存储）。 */
  readonly repository: Repository
  /** 上下文管理员（处理/打戳/组装）。 */
  readonly contextManager: ContextManager
  /** 快递员（倒计时 + 发送）。 */
  readonly courier: Courier
  readonly runtime: Runtime
  readonly tools?: ToolCapabilityRegistry
  /** 访问确认（ask 消息化：投递申请到根信箱 + access_reply 解析）。 */
  readonly access: AccessAskBus
  /** 统一事件流（PilotEvent：stream/letter/status/notice；多订阅者）。 */
  readonly events: EventHub
  /** 日志记录器。 */
  readonly logger: Logger
  /** 类回写端口（S5.2 进化书写面；undefined = 仅内存注册，无落盘通道）。 */
  private readonly classStore?: ClassStore
  /** 项目空间身份（S6/R11；根挂真实空间用）。 */
  private readonly project?: ProjectRef
  /** 启动期从持久化端口恢复出的实例（构造末尾接线上下文用；空 = 首启/纯内存）。 */
  private readonly restoredInstances: readonly AgentInstance[]
  /** user0 出生显示名（S9：config.user.displayName，缺省 'User'——实例参数经配置面给）。 */
  private readonly rootDisplayName: string

  constructor(options: KernelOptions) {
    this.rootDisplayName = options.userClass?.displayName ?? 'User'
    this.templates = new DefaultTemplateRegistry([
      buildUserClass(options.userClass),
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
    this.classStore = options.classStore
    this.project = options.project

    // 统一事件流（多订阅者）：外部（shell/GUI）经 onEvent 订阅 stream/letter/status/notice。
    this.events = new DefaultEventHub()
    if (options.onEvent) this.events.subscribe(options.onEvent)

    // 族谱树门面（拓扑实时推导 + 能力台账物化 + 可见域，S5.1 合一）。
    this.lineage = new DefaultLineageTree({
      getInstance: (id) => this.instances.getSync(id),
      getAllInstances: () => this.instances.listAllSync(),
    })

    // 权限查询端口（tools registry / ask 总线统一消费树门面，kernel 只接线）。
    const accessResolver: AccessResolver = {
      accessOf: (agentId, key) => this.lineage.effectiveAccess(agentId, key),
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
      contextManager: this.contextManager,
      repository: this.repository,
      tools: options.tools,
      // S6/R6：模型解析归口族谱树四级律（defaultModel 单层链已拆除）。
      resolveModel: (agentId) => this.lineage.modelOf(agentId as string)?.ref,
      maxSteps: options.maxSteps,
      templates: this.templates,
      estimateCost: options.estimateCost,
      timer: options.timer,
      onEvent: (agentId, event) => this.events.emit({ type: 'stream', agentId, event }),
      onStatus: (agentId, from, to) => this.events.emit({ type: 'status', agentId, from, to, at: Date.now() }),
      onLog: { log: (event) => this.emitLog(event) },
    })

    // 工具自动记录 → 仓库（触发/成功/失败），不依赖 runtime 手动发送。
    this.tools?.setRecordSink?.((record, ctx) => {
      forget(this.contextManager.appendToolRecord(ctx.agentId, record), 'kernel:appendToolRecord', (event) => this.emitLog(event))
      if (record.status === 'success' && record.result) {
        if (record.result.metadata?.contextWait) return // 挂起通道（wait/pause）：等待填充，不 append
        forget(this.contextManager.appendHistory(ctx.agentId, {
          role: 'tool',
          content: record.result.text,
          toolCallId: record.invocation.id,
        }), 'kernel:appendToolHistory', (event) => this.emitLog(event))
      } else if (record.status === 'error') {
        const error = record.error
        const message =
          error !== undefined && 'message' in error
            ? `[ToolError ${error.kind}] ${error.message}`
            : '[ToolError execution_failed] 工具执行失败'
        forget(this.contextManager.appendHistory(ctx.agentId, {
          role: 'tool',
          content: message,
          toolCallId: record.invocation.id,
        }), 'kernel:appendToolError', (event) => this.emitLog(event))
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
    this.replayLineage()
    for (const instance of this.restoredInstances) {
      const template = this.templates.getSync(instance.classRef)
      const isRoot = instance.parentId === null
      forget(this.contextManager.register({
        agentId: instance.id,
        sendCountdownMs: isRoot ? template?.sendCountdown ?? 0 : template?.sendCountdown,
        assemble: !isRoot && template?.panel !== true,
        contextStrategy: template?.contextStrategy,
        custom: template?.custom,
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
        ...(isRoot ? {} : { onHold: (id: string) => forget(this.runtime.notifyHold(makeAgentID(id)), 'kernel:notifyHold', (event) => this.emitLog(event)) }),
      }), 'kernel:registerContext', (event) => this.emitLog(event))
    }
  }

  /**
   * 族谱全树重放（能力相物化的唯一重算入口，两条链路共用）：
   * entries 由实例行 + 类档案现值派生（own = 类 tools ∪ toolOverride，
   * model 原始层含出生快照）——启动恢复与运行期 agent_update 之后都走
   * 这里：权限收缩沿链下传自动重算，模型显式层重解析、子女快照层稳定
   * （"不级联"由数据结构保证，无特判逻辑）。纯派生态 = 重放幂等。
   */
  /**
   * 类装载后重接线（createStemSystem 在 runInit 完成后调一次）：构造期恢复接线
   * 时空间类尚未入模板表，箱的 strategy/custom 落为兜底（cortex 类会被静默接成
   * classic——S10 实测抓获）。类表载齐后按模板实况补对齐；根箱（user0）走
   * userClass 同步构造不受此限，跳过。
   */
  async realignRestoredInstances(): Promise<void> {
    for (const instance of this.restoredInstances) {
      if (instance.parentId === null) continue
      const template = this.templates.getSync(instance.classRef)
      if (!template) continue
      await this.contextManager.realign(instance.id, {
        contextStrategy: template.contextStrategy,
        custom: template.custom,
      })
    }
  }

  private replayLineage(): void {
    this.lineage.replay(
      this.instances.listAllSync().map((instance) => ({
        agentId: instance.id as string,
        parentId: instance.parentId as string | null,
        own: this.ownAccessOf(instance.id),
        model: {
          instanceModel: instance.model,
          classModel: this.templates.getSync(instance.classRef)?.model,
          // 出生快照随行优先（族规跨重启/跨重放，S6 §5）；无快照 = 按链再解析。
          ...(instance.modelSnapshot !== undefined ? { snapshot: instance.modelSnapshot } : {}),
        },
      })),
    )
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
  /** 存量根的身份对齐（pilot 幂等分支调用）：config.user.displayName 跨重启生效。 */
  async alignRootDisplayName(): Promise<void> {
    const root = this.instances.getSync(makeAgentID(USER_ID))
    if (root !== undefined && root.displayName !== this.rootDisplayName) {
      await this.instances.update(makeAgentID(USER_ID), { displayName: this.rootDisplayName })
    }
  }

  async registerRootAgent(displayName?: string): Promise<AgentID> {
    const template = await this.templates.get(USER_CLASS_ID)
    // S6/R11：根挂**真实项目空间**（废除旧 getOrCreate('user0') 伪空间行——
    // 全体平等原则下根不需要专属空间；老卷残留由宿主存储层 v2 迁移归并）。
    const rootSpace = await this.spaces.getOrCreate(this.project ?? '')
    const instance = await this.instances.instantiate({
      className: USER_CLASS_ID,
      parentId: null,
      userPrompt: '',
      spaceId: rootSpace.id,
      agentId: USER_ID,
    })
    // 能力绑定（根：自身清单 = user 类 tools 整表，物化生效权限；
    // 模型相：根的类基因 = 家学锚点 config.user.model，全链默认值）。
    this.lineage.attach({
      agentId: USER_ID,
      parentId: null,
      own: this.ownAccessOf(makeAgentID(USER_ID)),
      model: { instanceModel: instance.model, classModel: template.model },
    })
    this.emitLog({
      type: 'kernel.instance.created',
      at: Date.now(),
      agentId: instance.id,
      classId: instance.classRef,
      parentId: '',
    })
    // 出生显示名：显式参数 > config.user.displayName > 'User'。
    const rootName = displayName ?? this.rootDisplayName
    if (rootName !== instance.displayName) await this.instances.update(makeAgentID(USER_ID), { displayName: rootName })
    await this.contextManager.register({
      agentId: USER_ID,
      systemPrompt: template.systemPrompt,
      sendCountdownMs: template.sendCountdown ?? 0,
      assemble: false,
      contextStrategy: template.contextStrategy,
      custom: template.custom,
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
    const template = await this.templates.get(instance.classRef)
    // 能力绑定（注册两步曲：继承父档案 → 自身清单收敛；grant = 系统通道加法整表）。
    // S6/R6：模型配置相同步物化——出生链 显式(opts/实例行) > 类基因 > 父继承 > 家学。
    this.lineage.attach({
      agentId: instance.id as string,
      parentId: instance.parentId as string | null,
      own: this.ownAccessOf(instance.id),
      model: { instanceModel: instance.model, classModel: template.model },
      ...(opts.accessMode === 'grant' ? { mode: 'grant' as const } : {}),
    })
    // §5 族规持久化：出生解析落在父继承/家学层 → 快照随实例行（"改父不动子"
    // 跨重启不失效）。根的 home 不写快照——家学 = config 本体，编辑重启应生效。
    const binding = this.lineage.modelOf(instance.id as string)
    if (
      binding !== undefined &&
      instance.parentId !== null &&
      instance.modelSnapshot === undefined &&
      (binding.origin === 'inherited' || binding.origin === 'home')
    ) {
      await this.instances.setModelSnapshot(instance.id, binding)
    }
    this.emitLog({
      type: 'kernel.instance.created',
      at: Date.now(),
      agentId: instance.id,
      classId: instance.classRef,
      parentId: instance.parentId ?? '',
    })

    // 模块扮演面板（class panel=true：策略 role 等）：不组装、不跑 LLM 轮，
    // 信件由扮演模块消费（信箱配对 waitForReply / 审计），与 user0 面板同构。
    const isPanel = template.panel === true
    await this.contextManager.register({
      agentId: instance.id,
      systemPrompt: template.systemPrompt,
      sendCountdownMs: template.sendCountdown,
      assemble: !isPanel,
      contextStrategy: template.contextStrategy,
      custom: template.custom,
      onDelivery: isPanel
        ? () => {}
        : (delivery) => this.handleDelivery(delivery),
      ...(isPanel ? {} : { onHold: (id: string) => forget(this.runtime.notifyHold(makeAgentID(id)), 'kernel:notifyHold', (event) => this.emitLog(event)) }),
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

    // wait 配对先于首信投递（S9 竞态根除：子存在的任何输出都晚于 hold）。
    if (opts.hold !== undefined && instance.parentId !== null) {
      await this.contextManager.registerHold(instance.id, {
        ownerId: instance.parentId,
        toolCallId: opts.hold.toolCallId,
        ...(opts.hold.timeoutMs !== undefined ? { timeoutMs: opts.hold.timeoutMs } : {}),
      })
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
  async spawnRoleAgent(hostAgentId: string, role: AgentClass): Promise<string> {
    const host = makeAgentID(hostAgentId)
    const className = role.name
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
  async spawnStrategyWorker(roleAgentId: string, task: string, spec: AgentClass): Promise<string> {
    const role = makeAgentID(roleAgentId)
    await this.ensureSystemTemplate(spec)
    const roleInstance = this.instances.getSync(role)
    if (!roleInstance) throw { kind: 'agent_not_found', agentId: role }
    return this.instantiateInSpace(
      { className: spec.name, parentId: role, userPrompt: task, accessMode: 'grant' },
      roleInstance.spaceId,
    )
  }

  /** 策略声明的系统模板 ensure（幂等；策略硬编码自身人设——决策 C）。
   *  S9 类形态统一：入参即 AgentClass 本尊，**零字段映射**（旧 spec→class
   *  手写搬运是配置漂移源，已根除）；仅缺省兜底两拍。 */
  private async ensureSystemTemplate(cls: AgentClass): Promise<void> {
    if (this.templates.getSync(cls.name)) return
    await this.templates.register({
      ...cls,
      sendCountdown: cls.sendCountdown ?? 0,
      contextStrategy: cls.contextStrategy ?? 'none',
    })
    this.emitLog({ type: 'kernel.class.registered', at: Date.now(), classId: cls.name })
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
      this.lineage.detach(id as string)
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
    // 中断权 = 可见域（自身或祖先，S5.1 统一树谓词）。
    if (!this.lineage.canReach(by, target)) {
      throw { kind: 'agent_terminate_denied', agentId: target, by: by as string }
    }
    this.runtime.abort(target)
  }

  /** 中断所有活跃 agent（进程优雅收尾用；只置中断标志，不等收尾）。 */
  abortAllAgents(): void {
    this.runtime.abortAll()
  }

  /** 优雅收尾专用：中断全部活跃轮并**等待** halt 收尾落行
   *（status→interrupted、消息闭合）——storage.close 前必须完成，
   * 否则进行中轮的账目/状态快照被退出吞掉（验收现场 bug）。 */
  async drainForShutdown(timeoutMs = 5000): Promise<void> {
    this.runtime.abortAll()
    await this.runtime.drainActiveTurns(timeoutMs)
  }

  /**
   * 实例参数统一更新（agent config 面的唯一运行期写通道——
   * agent_update 工具与 pilot 通道共用；合并吸收原 set_model 散点）。
   *
   * 顺序 = 可见域鉴权 → 总序校验（toolsPatch 对现自身清单只许收敛，扩张
   * 逐键拒绝）→ 实例行写（写穿持久）→ **族谱全树 replay**（收缩沿链下传
   * 自动重算；模型不级联由子女出生快照层天然保证）。
   * by 缺省 = 跳过可见域判定（信任调用方——pilot 宿主通道语义）。
   */
  async updateAgent(spec: AgentUpdateSpec): Promise<void> {
    const id = makeAgentID(spec.agentId)
    if (spec.by !== undefined && !this.lineage.canReach(makeAgentID(spec.by), id)) {
      throw { kind: 'agent_update_denied', agentId: spec.agentId, by: spec.by }
    }
    const instance = this.instances.getSync(id)
    if (!instance) throw { kind: 'agent_not_found', agentId: spec.agentId }
    const fields: string[] = []
    const patch: AgentInstancePatch = {}
    if (spec.toolsPatch !== undefined) {
      // 收敛 patch：对目标**当前生效显式面**（链摊平 + 自身值）逐键总序校验。
      const surface = this.lineage.profileOf(spec.agentId)?.explicit ?? {}
      const violations = checkToolsConvergence(surface, spec.toolsPatch)
      if (violations.length > 0) {
        throw { kind: 'agent_update_expanded', agentId: spec.agentId, violations }
      }
      // 合并写 override = 生效显式面全量 + patch——若以"类 ∪ 现 override"为基线，
      // 继承形实例（类无表）首更时父档案里的键会被静默挤出（own 跳变封闭面
      // + fallback deny = 能力清零悬崖）；以显式摊平面为基线则更新只动提及键。
      patch.toolOverride = { ...surface, ...spec.toolsPatch }
      fields.push('tools')
    } else if (spec.toolsGrant !== undefined) {
      // 清单形整表替换（受限 grant）：未列一律 deny；逐键封顶由台账物化保证。
      patch.toolOverride = spec.toolsGrant
      fields.push('toolsGrant')
    }
    if (spec.model !== undefined) {
      patch.model = spec.model
      fields.push('model')
    }
    if (spec.displayName !== undefined) {
      patch.displayName = spec.displayName
      fields.push('displayName')
    }
    if (fields.length === 0) return
    await this.instances.update(id, patch)
    this.replayLineage()
    if (spec.model !== undefined) {
      this.emitLog({
        type: 'kernel.model.set',
        at: Date.now(),
        agentId: spec.agentId,
        provider: spec.model.provider,
        model: spec.model.id,
        by: spec.by ?? 'pilot',
      })
    }
    this.emitLog({
      type: 'kernel.instance.updated',
      at: Date.now(),
      agentId: spec.agentId,
      by: spec.by ?? 'pilot',
      fields,
    })
  }

  /**
   * 运行改写模型薄壳（pilot/宿主通道）：委托 updateAgent 统一通道。
   * 不传 by = 跳过可见域判定（历史契约：授权由调用层负责）。
   */
  async setAgentModel(agentId: string, model: ModelRef, opts?: { by?: string }): Promise<void> {
    await this.updateAgent({
      agentId,
      model,
      ...(opts?.by !== undefined ? { by: opts.by } : {}),
    })
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
      // P6：runDelivery 入口前置查询可抛对象错误——孤儿 promise 曾击落进程。
      forget(this.runtime.processDelivery(delivery), 'kernel:processDelivery', (event) => this.emitLog(event))
    }
  }

  /** 注册新 agent 类（供系统工具 agent_class_create 使用，含日志与可选落盘；by = 发起者审计归属）。 */
  async registerAgentClass(
    cls: AgentClass,
    opts?: { persist?: boolean; by?: string },
  ): Promise<{ persisted: boolean }> {
    await this.templates.register(cls)
    const persisted = await this.persistClass(cls, opts)
    this.emitLog({
      type: 'kernel.class.registered',
      at: Date.now(),
      classId: cls.name,
      persisted,
      ...(opts?.by !== undefined ? { agentId: opts.by } : {}),
    })
    return { persisted }
  }

  /**
   * 更新 agent 类（S5.2 进化书写面；供 agent_class_update 使用）。
   * 收敛校验在工具层（checkToolsConvergence）；此处只管合并/落盘/审计。
   * 边界（方案 §4.2）：更新只影响**后续实例**——已绑定实例的能力已物化于族谱树。
   */
  async updateAgentClass(
    name: AgentClassID,
    patch: Partial<AgentClass>,
    opts?: { persist?: boolean; by?: string },
  ): Promise<{ persisted: boolean; cls: AgentClass }> {
    await this.templates.update(name, patch)
    const merged = await this.templates.get(name)
    const persisted = await this.persistClass(merged, opts)
    this.emitLog({
      type: 'kernel.class.updated',
      at: Date.now(),
      classId: merged.name,
      patch: Object.keys(patch).join(','),
      persisted,
      ...(opts?.by !== undefined ? { agentId: opts.by } : {}),
    })
    return { persisted, cls: merged }
  }

  /** 是否具备类落盘通道（工具文案区分"已落盘 / 仅内存试验田"）。 */
  hasClassStore(): boolean {
    return this.classStore !== undefined
  }

  /** 落盘一次类（persist 未请求 / 无端口 → false；序列化异常（panel 红线等）向上抛为工具失败）。 */
  private async persistClass(cls: AgentClass, opts?: { persist?: boolean }): Promise<boolean> {
    if (opts?.persist !== true || this.classStore === undefined) return false
    await this.classStore.save(cls)
    return true
  }

  /** 发送日志事件（直接写入日志记录器，无总线中转）。 */
  private emitLog(event: LogEvent): void {
    this.logger.log(event)
  }
}
