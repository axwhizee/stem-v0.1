// ============================================================
// core/kernel/Kernel.ts —— Kernel 组合根（core 内部装配）
//
// 装配：模板注册表 / 实例管理 / 空间 / 族谱树（拓扑 + 能力 + 可见域门面）
//      / 上下文仓库+管理员+快递员 / 运行时 / ask 总线 / 工具注册表。
//
// 权限模型（注册表 + 单操作收敛链）：生效权限 = 族谱位置的函数——实例注册
// （创建/恢复）时经 lineage.attach/replay 物化：收敛链 steps（类清单→
// [策略清单]→实例清单，逐步折叠不预合并）+ 出生表 caps 全局封顶；写入面
// （实例化/更新/根注册）走同一代数做**拒绝式校验**（扩张即拒、带层归因），
// 物化面静默钳制（重启幂等）。tools registry / ask 总线经 AccessResolver
// 端口查询，kernel 只做接线，不再逐层拼装。
//
// 通信模型（重建邮局，无总线）：
//   - sendMessage(from, to, payload) → 管理员 deposit（打戳 + 入库 + 触发处理）；
//   - 事件（stream/letter/status/notice）统一经 events hub 发布（PilotEvent）；
//   - 访问确认（ask）消息化：投递申请到根信箱 + access_reply 工具解析（见 tools/accessRequest）。
// 参与者查询：复用 instances + 根（无独立注册表）。
// 根（user#0）是 user 类的普通实例（parentId=null、id 纯推导 `0`），与全体 agent 平等。
// ============================================================

import type { ModelGateway } from '../gateway'
import type { ModelRef, UsageEvent } from '../gateway'
import type {
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
import { DefaultAccessAskBus, formatAccessRequest, foldConvergenceSteps } from '../tools'
import type { ConvergenceLayer, ConvergenceStep, ConvergenceStepMode } from '../tools'
import type { EventHub, PilotEvent } from '../events'
import { DefaultEventHub } from '../events'

/** agent_update 统一通道入参（可写面 = name/model/temperature/effort）。 */
interface AgentUpdateSpec {
  readonly agentId: string
  /** 发起者；缺省 = 跳过可见域判定（pilot 信任通道）。 */
  readonly by?: string
  readonly name?: string
  readonly model?: ModelRef
  readonly temperature?: number
  readonly effort?: 'none' | 'low' | 'medium' | 'high'
}

import type { ToolCapabilityRegistry } from '../tools'
import { DefaultTemplateRegistry } from './TemplateRegistry'
import type { TemplateRegistry } from './TemplateRegistry'
import { DefaultInstanceManager } from './InstanceManager'
import type { InstanceManager, InstantiateOptions } from './InstanceManager'
import { PersistedInstanceManager } from './persisted'
import type { InstanceStore } from './store'
import type { RuntimePort, RuntimePortDeps } from './runtimePort'
import { DefaultLineageTree } from '../lineage'
import type { AccessProfile, LineageBindEntry, LineageTree } from '../lineage'
import { ASSISTANT, buildUserClass } from './builtin/agents'
import type { UserClassConfig } from './builtin/agents'
import type { AgentClass, AgentClassID, AgentID, AgentInstance, AgentInstancePatch, ModelBinding, ProjectRef } from './types'
import { makeAgentID, ROOT_ID, ROOT_NAME, USER_CLASS_ID } from './types'

/**
 * 内置模板（类形态统一：唯一定义域 `kernel/builtin/agents.ts`）。
 * = assistant 占位类（tools 不写 = 完整继承父档案，模型落四级解析链——
 * internal 保底一张白纸）；user 类不在内（config 驱动，构造期 buildUserClass 装配）。
 */
export const BUILTIN_TEMPLATES: readonly AgentClass[] = [ASSISTANT]

export interface KernelOptions {
  readonly gateway: ModelGateway
  /** 追加/覆盖内置模板（内置 = builtin/agents.ts 类表）。 */
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
  /** 工具结果进入上下文的字符上限（config.tools.outputLimit；0/未设 = 不启用）。 */
  readonly toolOutputLimit?: number
  readonly estimateCost?: (usage: UsageEvent | undefined) => number
  /** 统一事件流回调（PilotEvent：stream/letter/status/notice；shell/GUI 订阅）。 */
  readonly onEvent?: (event: PilotEvent) => void
  /** 日志记录器（缺省内存版）。 */
  readonly logger?: Logger
  /**
   * 根的类配置（config.user 全对象：tools/systemPrompt/
   * sendCountdown/model/contextStrategy）；tools 缺省 = 不设限（完整继承
   * 注册表出生表面；推荐清单实值住首启模板 defaults.ts）。
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
   * 根挂此空间（废除伪 space 行）；缺省 = 匿名单空间（纯内存/测试）。
   */
  readonly project?: ProjectRef
  /**
   * agent 执行器工厂（D3 端口倒置）：组合根注入 main/runtime 实现；
   * Kernel 只认 RuntimePort 接口。
   */
  readonly runtime: (deps: RuntimePortDeps) => RuntimePort
}

/** 类回写端口（写侧序列化在 core，文件 IO 由宿主实现——零平台依赖不破）。 */
export interface ClassStore {
  readonly save: (cls: AgentClass) => Promise<void>
}

export class Kernel {
  readonly templates: TemplateRegistry
  readonly instances: InstanceManager
  /** 族谱树门面（拓扑实时推导 + 能力物化 + 可见域；S5.1 起台账并入）。 */
  readonly lineage: LineageTree
  /** 上下文仓库（上下文本体的唯一存储）。 */
  readonly repository: Repository
  /** 上下文管理员（处理/打戳/组装）。 */
  readonly contextManager: ContextManager
  /** 快递员（倒计时 + 发送）。 */
  readonly courier: Courier
  readonly runtime: RuntimePort
  readonly tools?: ToolCapabilityRegistry
  /** 访问确认（ask 消息化：投递申请到根信箱 + access_reply 解析）。 */
  readonly access: AccessAskBus
  /** 统一事件流（PilotEvent：stream/letter/status/notice；多订阅者）。 */
  readonly events: EventHub
  /** 日志记录器。 */
  readonly logger: Logger
  /** 类回写端口（S5.2 进化书写面；undefined = 仅内存注册，无落盘通道）。 */
  private readonly classStore?: ClassStore
  /** 项目身份（单空间；ToolContext.spaceId / bash cwd 用）。 */
  readonly project: ProjectRef
  /** 启动期从持久化端口恢复出的实例（wireRestoredContexts 接线用；空 = 首启/纯内存）。 */
  private readonly restoredInstances: readonly AgentInstance[]
  /** 根的出生称呼（config.user.name，缺省 'user'——实例参数经配置面给）。 */
  private readonly rootName: string
  /** 策略注册表（收敛链策略层解析口；缺省 = 无策略声明参与）。 */
  private readonly strategies?: StrategyRegistry

  constructor(options: KernelOptions) {
    this.rootName = options.userClass?.name ?? ROOT_NAME
    this.strategies = options.strategies
    this.project = options.project ?? ''
    this.templates = new DefaultTemplateRegistry([
      buildUserClass(options.userClass),
      ...(options.templates ?? BUILTIN_TEMPLATES),
    ])

    // ---------- 持久化装配（可选 stateStore 注入，core 零平台依赖：端口由宿主实现） ----------
    // 内存核 → （注入时）同一对内存核上恢复 → 套 write-through 装饰器（恢复期不反向写）。
    // 上下文接线推迟到 wireRestoredContexts（runInit 载齐类后调用）。
    const store = options.stateStore
    const memoryInstances = new DefaultInstanceManager(this.templates)
    const memoryRepository = new DefaultRepository({ onLog: (event) => this.emitLog(event) })
    if (store) {
      const persistedInstances = new PersistedInstanceManager(memoryInstances, store.instances)
      const persistedRepository = new PersistedRepository(memoryRepository, store.messages)
      this.restoredInstances = persistedInstances.restoreFromStore()
      persistedRepository.restoreFromStore()
      this.instances = persistedInstances
      this.repository = persistedRepository
    } else {
      this.restoredInstances = []
      this.instances = memoryInstances
      this.repository = memoryRepository
    }
    this.tools = options.tools
    this.logger = options.logger ?? new InMemoryLogger()
    this.classStore = options.classStore

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
          { role: 'user', content: formatAccessRequest(request, (id) => this.displayOf(id)) },
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
      // 信件戳身份面（B4）：from id → `name#id` 全名。
      identityOf: (agentId) => this.displayOf(agentId),
      // 反馈式水位（cortex 等策略判据）：节点最近一次 prompt_tokens。
      ctxTokensOf: (agentId) => this.instances.getSync(makeAgentID(agentId))?.ctxTokens,
      onLog: (event) => this.emitLog(event),
    })
    // 仓库 onChange → 管理员处理入口。
    this.repository.onChange = (agentId) => this.contextManager.handleChange(agentId)

    this.runtime = options.runtime({
      gateway: options.gateway,
      instances: this.instances,
      contextManager: this.contextManager,
      repository: this.repository,
      tools: options.tools,
      // S6/R6：模型解析归口族谱树四级律（defaultModel 单层链已拆除）。
      resolveModel: (agentId) => this.lineage.modelOf(agentId as string)?.ref,
      maxSteps: options.maxSteps,
      ...(options.toolOutputLimit !== undefined ? { toolOutputLimit: options.toolOutputLimit } : {}),
      templates: this.templates,
      estimateCost: options.estimateCost,
      timer: options.timer,
      projectRoot: this.project,
      onEvent: (agentId, event) => this.events.emit({ type: 'stream', agentId, event }),
      onStatus: (agentId, from, to) => this.events.emit({ type: 'status', agentId, from, to, at: Date.now() }),
      onLog: { log: (event) => this.emitLog(event) },
    })

    // 工具记录 sink（记录/历史回填 + 事件流 tool 相位）由组合根接线：
    // `main/toolWiring.attachToolRecordSink`（Kernel 不再自接线，DIP）。
    // 工具调用日志；访问确认 → AccessAskBus；族谱权限查询 → 台账。
    this.tools?.setLogSink?.({ log: (event) => this.emitLog(event) })
    this.tools?.setAccessSink?.(this.access)
    this.tools?.setAccessResolver?.(accessResolver)
  }

  /**
   * 恢复接线（runInit 载齐类/策略后由 createStemSystem 调用一次）：
   * 启动 replay 族谱 + 为每个恢复实例注册上下文（restore=true：箱已重建）。
   * 构造期不接线——类模板未载时策略/custom 会落错（S10 教训的根治）。
   */
  async wireRestoredContexts(): Promise<void> {
    if (this.restoredInstances.length === 0) return
    this.replayLineage()
    for (const instance of this.restoredInstances) {
      const template = this.templates.getSync(instance.classRef)
      const isRoot = instance.parentId === null
      if (instance.modelBinding === undefined) {
        const binding = this.lineage.modelOf(instance.id)
        if (binding) await this.instances.setModelBinding(instance.id, binding)
      }
      // 类缺失：先以兜底接线，再 realign 留痕（与旧构造期接线+补对齐同语义）。
      const missingClass = !isRoot && !template
      forget(this.contextManager.register({
        agentId: instance.id,
        sendCountdownMs: isRoot ? template?.sendCountdown ?? 0 : template?.sendCountdown,
        assemble: instance.assemble ?? (!isRoot && true),
        contextStrategy: missingClass ? undefined : template?.contextStrategy,
        restore: this.repository.has(instance.id),
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
      if (missingClass) {
        await this.contextManager.realign(instance.id, { contextStrategy: '' })
      }
    }
  }

  /** 某 agent 的族谱绑定条目（权限 steps + 模型原始层/已落地绑定）。 */
  private bindEntryOf(instance: AgentInstance): LineageBindEntry {
    const template = this.templates.getSync(instance.classRef)
    return {
      agentId: instance.id as string,
      parentId: instance.parentId as string | null,
      steps: this.accessStepsOf(instance.id),
      caps: this.birthCaps(),
      model: {
        instanceModel: instance.model,
        classModel: template?.model,
        ...(instance.modelBinding !== undefined ? { resolved: instance.modelBinding } : {}),
      },
    }
  }

  private replayLineage(): void {
    this.lineage.replay(this.instances.listAllSync().map((instance) => this.bindEntryOf(instance)))
  }

  /** 某 agent 的收敛链步序（类清单 → [策略声明清单 raise] → 实例清单；逐步独立、不做预合并）。 */
  private accessStepsOf(agentId: AgentID): readonly (ConvergenceStep | undefined)[] {
    const instance = this.instances.getSync(agentId)
    if (!instance) return []
    const template = this.templates.getSync(instance.classRef)
    return [this.listStep(template?.tools), this.strategyStep(template?.contextStrategy), this.listStep(instance.toolOverride)]
  }

  /** 白名单步原料（undefined = 该层不设限）。 */
  private listStep(list: Readonly<Record<string, ToolAccess>> | undefined): ConvergenceStep | undefined {
    return list === undefined ? undefined : { list }
  }

  /** 策略声明清单步（raise——只抬不封；策略未声明/解析缺位 = 无此步）。 */
  private strategyStep(contextStrategy: string | undefined): ConvergenceStep | undefined {
    if (contextStrategy === undefined) return undefined
    const tools = this.strategies?.resolve(contextStrategy)?.tools
    return tools !== undefined && Object.keys(tools).length > 0 ? { list: tools, mode: 'raise' } : undefined
  }

  /** 出生表（注册行为生成的全局封顶；无注册表面 = 不封顶）。 */
  private birthCaps(): Readonly<Record<string, ToolAccess>> {
    return this.tools?.birthTable() ?? {}
  }

  /**
   * 写入面拒绝式校验（与物化共用 foldConvergenceSteps 单一代数）：逐步折叠，
   * 取值宽于封顶（父面显式判定 ∧ 出生值）= 扩张 → 违例带层归因
   * （"类收敛被拒" ≠ "实例收敛被锁"）。整表缺席的步跳过（= 该层不设限）。
   */
  private validateAccessSteps(
    parent: AccessProfile | undefined,
    steps: readonly (readonly [ConvergenceLayer, Readonly<Record<string, ToolAccess>>, ConvergenceStepMode | undefined])[],
  ): string[] {
    const { violations } = foldConvergenceSteps(parent?.explicit ?? {}, this.birthCaps(), steps)
    return violations.map(
      (v) => `${v.layer}被拒 ${v.key}: ${v.wanted}（封顶 ${v.ceiling}——扩张被拒，只许沿 ignore→allow→ask→deny 收紧）`,
    )
  }

  /** 收敛链步序 → 带层标签三元组（层名按链位分配：两步 = 类/实例；三步含策略层）。 */
  private labeledSteps(
    steps: readonly (ConvergenceStep | undefined)[],
    first: ConvergenceLayer,
  ): (readonly [ConvergenceLayer, Readonly<Record<string, ToolAccess>>, ConvergenceStepMode | undefined])[] {
    const labels: ConvergenceLayer[] =
      steps.length >= 3 ? [first, '策略收敛', '实例收敛'] : [first, '实例收敛']
    return steps
      .map((step, i) => (step === undefined ? undefined : [labels[i] ?? '实例收敛', step.list, step.mode] as const))
      .filter((p): p is readonly [ConvergenceLayer, Readonly<Record<string, ToolAccess>>, ConvergenceStepMode | undefined] => p !== undefined)
  }

  /** 注册根 agent：从内置 user 类实例化（parentId=null 即根，与其他实例等同；id = 出生路径 `0`）。 */
  /** 存量根的身份对齐（pilot 幂等分支调用）：config.user.name 跨重启生效。 */
  async alignRootName(): Promise<void> {
    const root = this.instances.getSync(ROOT_ID)
    if (root !== undefined && root.name !== this.rootName) {
      await this.instances.update(ROOT_ID, { name: this.rootName })
    }
  }

  async registerRootAgent(name?: string): Promise<AgentID> {
    const template = await this.templates.get(USER_CLASS_ID)
    const rootViolations = this.validateAccessSteps(undefined, this.labeledSteps([this.listStep(template.tools)], '根收敛'))
    if (rootViolations.length > 0) {
      throw { kind: 'root_config_expanded', message: `config.user.tools 越出生声明被拒：\n${rootViolations.join('\n')}` }
    }
    const instance = await this.instances.instantiate({
      className: USER_CLASS_ID,
      parentId: null,
      userPrompt: '',
    })
    // 能力绑定（根：自身清单 = user 类 tools 整表，物化生效权限；
    // 模型相：根的类基因 = 家学锚点 config.user.model，全链默认值）。
    this.lineage.attach({
      agentId: instance.id,
      parentId: null,
      steps: [this.listStep(template.tools)],
      caps: this.birthCaps(),
      model: { instanceModel: instance.model, classModel: template.model },
    })
    const binding = this.lineage.modelOf(instance.id as string)
    if (binding) await this.instances.setModelBinding(instance.id, binding)
    this.emitLog({
      type: 'kernel.instance.created',
      at: Date.now(),
      agentId: instance.id,
      classId: instance.classRef,
      parentId: '',
    })
    // 出生称呼：显式参数 > config.user.name > 'user'。
    const rootName = name ?? this.rootName
    if (rootName !== instance.name) await this.instances.update(instance.id, { name: rootName })
    await this.contextManager.register({
      agentId: instance.id,
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
    await this.sendMessage(ROOT_ID, agentId, text)
  }

  /**
   * 寻址解析（B3 三形态统一入口，写面专用）：`name#id` 精确制导 → 精确 id →
   * 唯一 id 前缀 → name。失败抛 agent_not_found / agent_ref_ambiguous（带候选）。
   */
  resolveAgent(ref: string): AgentID {
    const result = this.instances.resolve(ref)
    if ('found' in result) return result.found
    if ('ambiguous' in result) throw { kind: 'agent_ref_ambiguous', ref, candidates: result.ambiguous }
    throw { kind: 'agent_not_found', agentId: makeAgentID(ref) }
  }

  /** 全名呈现（`name#id`；信件戳/参与者/错误 message 的统一出口）。 */
  displayOf(agentId: string): string {
    return this.instances.displayOf(agentId)
  }

  /**
   * agent 间通信（无总线，直接投递到上下文管理员）。
   * from/to 为参与者 id（出生路径）。
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
  async instantiateAgent(opts: Omit<InstantiateOptions, 'spaceId' | 'modelBinding'>, project?: ProjectRef): Promise<AgentID> {
    return this.instantiateInSpace(opts)
  }

  /** 实例化（系统工具 agent_instantiate / 策略 spawn 共用；单空间无 spaceId）。 */
  async instantiateInSpace(opts: Omit<InstantiateOptions, 'spaceId' | 'modelBinding'>): Promise<AgentID> {
    const template = await this.templates.get(opts.className)
    // 写入面拒绝式校验（两步独立归因；grant = 系统通道静默钳制不拒绝）。
    if (opts.accessMode !== 'grant') {
      const violations = this.validateAccessSteps(
        opts.parentId !== null ? this.lineage.profileOf(opts.parentId as string) : undefined,
        this.labeledSteps([this.listStep(template.tools), this.strategyStep(template.contextStrategy), this.listStep(opts.tools)], '类收敛'),
      )
      if (violations.length > 0) {
        throw { kind: 'tools_convergence_expanded', violations }
      }
    }
    const instance = await this.instances.instantiate(opts)
    // 能力绑定（注册两步曲：继承父档案 → 自身清单收敛；grant = 系统通道加法整表）。
    this.lineage.attach({
      agentId: instance.id as string,
      parentId: instance.parentId as string | null,
      ...(opts.accessMode === 'grant'
        ? { own: { ...template.tools, ...instance.toolOverride }, mode: 'grant' as const, caps: this.birthCaps() }
        : { steps: this.accessStepsOf(instance.id), caps: this.birthCaps() }),
      model: { instanceModel: instance.model, classModel: template.model },
    })
    // 出生解析落地：生效绑定随行持久（自包含；改父不动子由已落地绑定保证）。
    const binding = this.lineage.modelOf(instance.id as string)
    if (binding) await this.instances.setModelBinding(instance.id, binding)
    // temperature/effort 出生落地：显式 > 类基因 > 父。
    const parent = instance.parentId !== null ? this.instances.getSync(instance.parentId) : undefined
    if (instance.temperature === undefined) {
      const t = template.temperature ?? parent?.temperature
      if (t !== undefined) await this.instances.update(instance.id, { temperature: t })
    }
    if (instance.effort === undefined) {
      const e = template.effort ?? parent?.effort
      if (e !== undefined) await this.instances.update(instance.id, { effort: e })
    }
    this.emitLog({
      type: 'kernel.instance.created',
      at: Date.now(),
      agentId: instance.id,
      classId: instance.classRef,
      parentId: instance.parentId ?? '',
    })

    // 模块扮演面板（创建方 assemble=false）：不组装、不跑 LLM 轮，
    // 信件由扮演模块消费（信箱配对 waitForReply / 审计），与根面板同构。
    const isPanel = instance.assemble === false
    await this.contextManager.register({
      agentId: instance.id,
      systemPrompt: template.systemPrompt,
      sendCountdownMs: template.sendCountdown,
      assemble: !isPanel,
      contextStrategy: template.contextStrategy,
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
      await this.contextManager.deposit(instance.id, { role: 'user', content: instance.userPrompt }, instance.parentId ?? ROOT_ID)
    }
    return instance.id
  }

  /**
   * 策略扮演 agent 懒生成（模块扮演模式：pilot 扮演根的同构推广）。
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
    return this.instantiateInSpace({ className, parentId: host, userPrompt: '', accessMode: 'grant', assemble: false })
  }

  /** 策略工具 worker 创建（父 = 扮演 agent；任务 = userPrompt 首信；回收交调用方）。 */
  async spawnStrategyWorker(roleAgentId: string, task: string, spec: AgentClass): Promise<string> {
    const role = makeAgentID(roleAgentId)
    await this.ensureSystemTemplate(spec)
    const roleInstance = this.instances.getSync(role)
    if (!roleInstance) throw { kind: 'agent_not_found', agentId: role }
    // worker 是正常组装 agent（跑 LLM 产出回信）——面板性只属于 role。
    return this.instantiateInSpace(
      { className: spec.name, parentId: role, userPrompt: task, accessMode: 'grant' },
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

  /**
   * 终止实例：销毁权校验（by 是祖先，实例管理器内 fail-fast）→ 实例删除
   * （含 recursive 级联）→ 逐个注销上下文（仓库行经装饰器归档）。
   * 顺序保证：校验先于一切副作用（原实现先注销目标上下文再校验，抛出时上下文已丢）。
   */
  async terminateAgent(agentId: string, opts?: { by?: string; recursive?: boolean }): Promise<void> {
    const target = makeAgentID(agentId)
    const subtree = [target, ...this.lineage.getDescendants(target)]
    await this.instances.terminate(target, {
      by: makeAgentID(opts?.by ?? ROOT_ID),
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
    const by = makeAgentID(opts?.by ?? ROOT_ID)
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
   * 实例参数统一更新（运行期可写面 = name / model）。
   * tools/策略/类字段不在此通道：tools 出生后不可改（属性表律），
   * 类定义走 agent_class_update。改模型只重绑节点自身，不级联。
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
    if (spec.model !== undefined) {
      patch.model = spec.model
      fields.push('model')
    }
    if (spec.temperature !== undefined) {
      patch.temperature = spec.temperature
      fields.push('temperature')
    }
    if (spec.effort !== undefined) {
      patch.effort = spec.effort
      fields.push('effort')
    }
    if (spec.name !== undefined) {
      patch.name = spec.name
      fields.push('name')
    }
    if (fields.length === 0) return
    await this.instances.update(id, patch)
    if (spec.model !== undefined) this.lineage.setModel(spec.agentId, spec.model)
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

  /** Scheduler 最小直通：已存在该模板实例则复用，否则创建。 */
  async getOrCreateAgent(
    className: AgentClassID,
    project: ProjectRef,
    opts?: { userPrompt?: string },
  ): Promise<AgentID> {
    const existing = await this.instances.listAll()
    const found = existing.find((agent) => agent.classRef === className)
    if (found) return found.id
    return this.instantiateAgent(
      {
        className,
        parentId: ROOT_ID,
        userPrompt: opts?.userPrompt ?? '你好，请做一个简短的自我介绍。',
      },
      project,
    )
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

  /** 参与者列表（复用实例 + 根，无独立注册表；呈现面统一 name#id——可直接作 mail to）。 */
  async listParticipants(): Promise<string[]> {
    const agents = await this.instances.listAll()
    const ids: string[] = [ROOT_ID, ...agents.map((a) => a.id)]
    return [...new Set(ids)].map((id) => this.instances.displayOf(id))
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

  /** 落盘一次类（persist 未请求 / 无端口 → false；序列化异常（系统机制红线等）向上抛为工具失败）。 */
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
