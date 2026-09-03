// ============================================================
// core/kernel/systemTools.ts —— 系统管理工具（Kernel 提供）
//
// 工具访问融合：kind=internal 系统工具默认 accessKey 下 'ignore'（隐藏），
//   显式 toolAccess 声明 allow 才暴露；类权限列表在 AgentClass.toolAccess。
// 工具执行器闭包引用 Kernel（组合根装配时注册到工具注册表）。
// 命名规范：`<模块>_<动作>`（bus_send / bus_participants / agent_*）。
// ============================================================

import type { ToolCapability } from '../tools'
import type { ToolAccess } from '../tools'
import { checkToolsConvergence } from '../tools'
import type { AccessReply } from '../tools'
import type { AccessProfile } from '../lineage'
import type { ModelOrigin } from '../lineage'
import type { ModelRef } from '../gateway'
import type { LogEvent } from '../logging'
import { eventInvolvesAgent } from '../logging'
import type { Kernel } from './Kernel'
import type { AgentClass } from './types'
import { makeAgentClassID, makeAgentID } from './types'

/** 生成系统工具清单（由 Kernel.registerSystemTools 装配）。 */
export function createSystemTools(kernel: Kernel): ToolCapability[] {
  return [
    agentClassCreate(kernel),
    agentClassUpdate(kernel),
    agentClassList(kernel),
    agentInstantiate(kernel),
    agentList(kernel),
    agentInspect(kernel),
    agentAncestry(kernel),
    agentDescendants(kernel),
    agentTerminate(kernel),
    agentUpdate(kernel),
    busSend(kernel),
    busParticipants(kernel),
    telemetryQuery(kernel),
    contextWait(kernel),
    contextExport(kernel),
    contextOverview(kernel),
    contextRemove(kernel),
    contextEdit(kernel),
    contextApply(kernel),
    accessReply(kernel),
  ]
}

/** 创建新 agent 类（admin 权限，D7/铁律 8）。只承载类属性，不含实例数据（userPrompt 等）。 */
function agentClassCreate(kernel: Kernel): ToolCapability {
  return {
    id: 'agent_class_create',
    description:
      '创建新的 agent 类（模板）并回写 `.stem/agent/<name>.md`（目录即真相，重启后仍生效——进化书写面）。新名 = 变体并存（供谱系对照与回滚）；同名会被拒绝（覆盖现役请用 agent_class_update）。类定义角色设定（systemPrompt / tools 工具清单 / contextStrategy / model / sendCountdown），不包含任何实例化数据（如 userPrompt）；实例化请用 agent_instantiate。tools 为工具访问键到访问动作的映射（键即白名单，未列出的工具不可用；对继承面只能收敛）。',
    accessKey: 'agent_class_create',
    kind: 'internal',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '类名（唯一，即类 id，kebab-case）' },
        description: { type: 'string', description: '类用途描述' },
        systemPrompt: { type: 'string', description: '该类的专属系统提示词' },
        tools: { type: 'object', description: '工具清单：访问键 → allow|ask|deny|ignore（键即白名单，对继承面收敛）' },
        contextStrategy: { type: 'string', description: '上下文管理策略（默认 classic）' },
        model: { type: 'string', description: '模型（"提供商/模型"，可选；缺省沿 父继承>家学 链解析）' },
        sendCountdown: { type: 'number', description: '送信倒计时毫秒（可选，缺省 1000）' },
      },
      required: ['name', 'description'],
    },
    execute: async (input, ctx) => {
      const args = input as {
        name: string
        description: string
        systemPrompt?: string
        tools?: Readonly<Record<string, ToolAccess>>
        contextStrategy?: string
        model?: string
        sendCountdown?: number
      }
      let model: ModelRef | undefined
      if (args.model !== undefined) {
        const parsed = parseModelArg(args.model)
        if (parsed === undefined) return { text: MODEL_FORMAT_HINT }
        model = parsed
      }
      const cls: AgentClass = {
        name: makeAgentClassID(args.name),
        description: args.description,
        systemPrompt: args.systemPrompt ?? '',
        tools: args.tools ?? {},
        ...(args.contextStrategy !== undefined ? { contextStrategy: args.contextStrategy } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(args.sendCountdown !== undefined ? { sendCountdown: args.sendCountdown } : {}),
      }
      await kernel.registerAgentClass(cls, { persist: true, by: ctx.agentId })
      return {
        text: `已创建 agent 类 ${args.name}（tools=${cls.tools === undefined ? '未设=继承父档案' : Object.keys(cls.tools).length + ' 条规则'}，${kernel.hasClassStore() ? '已落盘 .stem/agent/，重启后仍生效' : '仅内存注册——宿主未启用类回写通道'}）`,
      }
    },
  }
}

/**
 * 更新现役 agent 类（S5.2 进化书写面：同名覆盖 + 落盘，方案 §4.2）。
 * 边界（设计内）：①只影响**后续实例**（已绑定能力物化于族谱树，防"改类即远程改现役"）；
 * ②工具路径**只许收敛**（checkToolsConvergence——deny 不可撤销、ask 不许变执行免询问）；
 * ③panel 机制类与 user 根类不可改（红线：系统机制与用户基因分界；根人格归 config.user）。
 */
function agentClassUpdate(kernel: Kernel): ToolCapability {
  return {
    id: 'agent_class_update',
    description:
      '更新现役 agent 类并回写 `.stem/agent/<name>.md`（同名覆盖；进化书写面）。缺省目标 = 你所属的类（显式 name 可指向其它类，经 ask 授权）。tools 只能收敛（deny 不可撤销，ask 不得升为 allow/ignore）；systemPrompt/description/model/contextStrategy/sendCountdown 可改。**只影响后续实例**（你的既有权限面不变）。',
    accessKey: 'agent_class_update',
    kind: 'internal',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '目标类名（缺省 = 调用者所属类）' },
        description: { type: 'string', description: '新类描述' },
        systemPrompt: { type: 'string', description: '新系统提示词' },
        tools: { type: 'object', description: '工具清单增量更新（未提及键保留原值；提及键逐键只能收敛，不可扩张）' },
        contextStrategy: { type: 'string', description: '上下文策略名' },
        model: { type: 'string', description: '模型（"提供商/模型"）' },
        sendCountdown: { type: 'number', description: '送信倒计时毫秒' },
      },
    },
    execute: async (input, ctx) => {
      const args = input as {
        name?: string
        description?: string
        systemPrompt?: string
        tools?: Readonly<Record<string, ToolAccess>>
        contextStrategy?: string
        model?: string
        sendCountdown?: number
      }
      // 缺省目标 = 调用者所属类（自我进化主路径）。
      const selfClass = kernel.instances.getSync(makeAgentID(ctx.agentId))?.classRef
      const target = args.name !== undefined ? makeAgentClassID(args.name) : selfClass
      if (target === undefined) return { text: '无法确定目标类（请显式给出 name）' }
      if ((target as string) === 'user') {
        return { text: 'user 根类的基因由 config.user（stem.jsonc）承载，不经本通道改写' }
      }
      const current = kernel.templates.getSync(target)
      if (!current) return { text: `类不存在: ${target}（新建请用 agent_class_create）` }
      if (current.panel === true) {
        return { text: `panel 类 ${target} 为系统机制承载（策略 role 等），不可修改/回写（红线）` }
      }
      if (args.tools !== undefined) {
        const violations = checkToolsConvergence(current.tools, args.tools)
        if (violations.length > 0) {
          return { text: `工具清单只能收敛，以下违规：\n${violations.map((v) => `  - ${v}`).join('\n')}` }
        }
      }
      // tools patch = 增量合并（未提及键保留原值——整表替换会静默丢键，属意外收缩陷阱）。
      const mergedTools = args.tools !== undefined ? { ...current.tools, ...args.tools } : undefined
      let model: ModelRef | undefined
      if (args.model !== undefined) {
        const parsed = parseModelArg(args.model)
        if (parsed === undefined) return { text: MODEL_FORMAT_HINT }
        model = parsed
      }
      const patch: Partial<AgentClass> = {
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.systemPrompt !== undefined ? { systemPrompt: args.systemPrompt } : {}),
        ...(args.contextStrategy !== undefined ? { contextStrategy: args.contextStrategy } : {}),
        ...(args.sendCountdown !== undefined ? { sendCountdown: args.sendCountdown } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(mergedTools !== undefined ? { tools: mergedTools } : {}),
      }
      const patchKeys = Object.keys(patch).filter((k) => k !== 'name')
      if (patchKeys.length === 0) return { text: '无可更新字段（description/systemPrompt/tools/model/contextStrategy/sendCountdown 至少给一项）' }
      const { persisted } = await kernel.updateAgentClass(target, patch, { persist: true, by: ctx.agentId })
      return {
        text: `已更新类 ${target}（${patchKeys.join(', ')}；${persisted ? '已落盘 .stem/agent/' : '仅内存更新——宿主未启用类回写通道'}；对后续实例生效）`,
      }
    },
  }
}

/** 模型参数解析（S6/R6 严格式）：仅接受 `提供商/模型`，两段非空；非法 → undefined。 */
function parseModelArg(value: string): { provider: string; id: string } | undefined {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) }
}

const MODEL_FORMAT_HINT = 'model 必须是 "提供商/模型" 格式（提供商 = config providers 注册表的键；裸模型名无归属不受理）'

/** 模型解析命中层的中文谱系标签（agent_inspect 出示；R6 四级律）。 */
const MODEL_ORIGIN_LABELS: Record<ModelOrigin, string> = {
  explicit: '实例显式（出生指定或 set_model 改写）',
  class: '类基因',
  inherited: '父继承',
  home: '家学 = config.user.model',
}


/** 列出 agent 类。 */
function agentClassList(kernel: Kernel): ToolCapability {
  return {
    id: 'agent_class_list',
    description: '列出全部 agent 类（模板）及关键属性。',
    accessKey: 'agent_class_list',
    kind: 'internal',
    category: 'system',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const classes = await kernel.templates.list()
      const lines = classes.map(
        (c) =>
          `${c.name}  tools=${c.tools === undefined ? 'inherit' : Object.keys(c.tools).length > 0 ? Object.entries(c.tools).map(([t, a]) => `${t}:${a}`).join(',') : '-'}${c.contextStrategy ? `  strategy=${c.contextStrategy}` : ''}${c.model ? `  model=${c.model.id}` : ''}`,
      )
      return { text: lines.length > 0 ? `agent 类列表:\n${lines.join('\n')}` : '（暂无 agent 类）' }
    },
  }
}

/** 创建 agent 实例（必填 className + userPrompt；父 = 调用者）。 */
function agentInstantiate(kernel: Kernel): ToolCapability {
  return {
    id: 'agent_instantiate',
    description:
      '创建新的 agent 实例。必填 className（模板名）与 userPrompt（作为该 agent 的首条 user 消息）；族谱父自动为调用者。可选 agentId（唯一）、model（"提供商/模型" 显式覆盖出生模型；缺省 = 类基因 > 你的继承链）、contextRefs（父仓库消息索引，深拷贝传入）、tools（对模板工具清单的临时收敛）。创建后返回 agent id；若需等待其返回结果，请调用 context_wait(agentId)。',
    accessKey: 'agent_instantiate',
    kind: 'internal',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        className: { type: 'string', description: 'Agent 模板名' },
        userPrompt: { type: 'string', description: '实例化时附带的 user prompt（必填）' },
        agentId: { type: 'string', description: '指定新 agent 的 id（可选，缺省随机生成）' },
        model: { type: 'string', description: '显式模型 "提供商/模型"（可选；缺省按 类基因>父继承>家学 解析）' },
        contextRefs: { type: 'array', items: { type: 'string' }, description: '父仓库消息索引列表（消息 id 或轮索引），深拷贝传入新实例' },
        tools: { type: 'object', description: '工具清单补充：访问键 → ask/deny（对模板表临时收敛）' },
      },
      required: ['className', 'userPrompt'],
    },
    execute: async (input, ctx) => {
      const args = input as {
        className: string
        userPrompt: string
        agentId?: string
        model?: string
        contextRefs?: string[]
        tools?: Readonly<Record<string, ToolAccess>>
      }
      let model: ModelRef | undefined
      if (args.model !== undefined) {
        const parsed = parseModelArg(args.model)
        if (parsed === undefined) return { text: MODEL_FORMAT_HINT }
        model = parsed
      }
      const agentId = await kernel.instantiateInSpace(
        {
          className: makeAgentClassID(args.className),
          userPrompt: args.userPrompt,
          parentId: makeAgentID(ctx.agentId),
          agentId: args.agentId,
          contextRefs: args.contextRefs,
          tools: args.tools,
          ...(model !== undefined ? { model } : {}),
        },
        ctx.spaceId,
      )
      return { text: `已创建 agent ${agentId}` }
    },
  }
}

/**
 * 运行时换模型（S6/R7：模型自由三环之一——实例化可选 / 类基因 / 本通道随时调整）。
 * internal 缺省 ignore（白名单显式赋权），授权 = 树可见域 canReach（自身∨后代，
 * 无特权通道）；改后下一轮送信生效，**不级联**已出生子孙（R6 族规=出生快照）；
 * 显式层随实例行落盘（R14，重启延续）。provider 未接通/模型不在白名单 → 用到才硬错。
 */
function agentUpdate(kernel: Kernel): ToolCapability {
  return {
    id: 'agent_update',
    description:
      '更新 agent 实例的运行参数（缺省目标 = 你自己；祖先可改后代，**只许收紧不许放宽**）。' +
      'model = "提供商/模型"（下一轮生效，不级联已出生子孙的快照；随实例持久化）。' +
      'tools = {键:访问} 收敛补丁：提及键合并、逐键只许更严（deny≺ask≺allow≺ignore 单链），放宽会被逐键拒绝——' +
      '想藏起祖先给的能力（allow→ignore）同样是被拒的扩张。' +
      'grantTools = {键:访问} 清单形整表替换：你给出的就是全部可用清单，未列键一律 deny——' +
      '免于逐个填 deny 的负担，但每键仍被祖先显式判定封顶（ask 洗不成 allow）。tools 与 grantTools 互斥。' +
      'displayName = 实例显示名。类定义/父子拓扑/上下文策略/系统提示不在本通道（改类文件走 agent_class_update，拓扑是族谱事实）。',
    accessKey: 'agent_update',
    kind: 'internal',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: '目标 agent id（可选，缺省为调用者自身；仅自身或祖先可改）' },
        model: { type: 'string', description: '新模型 "提供商/模型"（可选）' },
        displayName: { type: 'string', description: '新显示名（可选）' },
        tools: { type: 'object', description: '收敛补丁：访问键 → allow/ask/deny/ignore，逐键只许收紧' },
        grantTools: { type: 'object', description: '清单形整表替换（与 tools 互斥）：给出的即全部清单，其余 deny' },
      },
    },
    execute: async (input, ctx) => {
      const args = input as {
        agentId?: string
        model?: string
        displayName?: string
        tools?: Record<string, ToolAccess>
        grantTools?: Record<string, ToolAccess>
      }
      const target = args.agentId ?? ctx.agentId
      if (!kernel.lineage.canReach(makeAgentID(ctx.agentId), makeAgentID(target))) {
        return { text: `无权更新该 agent（可见域 = 自身 + 族谱后代）: ${target}` }
      }
      if (args.tools !== undefined && args.grantTools !== undefined) {
        return { text: 'tools（收敛补丁）与 grantTools（清单整表替换）互斥，一次只用一种' }
      }
      const bad = [...Object.entries(args.tools ?? {}), ...Object.entries(args.grantTools ?? {})].find(
        ([, v]) => !['allow', 'ask', 'deny', 'ignore'].includes(String(v)),
      )
      if (bad !== undefined) return { text: `非法访问值 ${String(bad[1])}（键 ${bad[0]}）：allow/ask/deny/ignore 之一` }
      let model: ModelRef | undefined
      if (args.model !== undefined) {
        const parsed = parseModelArg(args.model)
        if (parsed === undefined) return { text: MODEL_FORMAT_HINT }
        model = parsed
      }
      if (model === undefined && args.displayName === undefined && args.tools === undefined && args.grantTools === undefined) {
        return { text: '至少给出一个更新字段（model / displayName / tools / grantTools）；现档案见 agent_inspect' }
      }
      try {
        await kernel.updateAgent({
          agentId: target,
          by: ctx.agentId,
          ...(model !== undefined ? { model } : {}),
          ...(args.displayName !== undefined ? { displayName: args.displayName } : {}),
          ...(args.tools !== undefined ? { toolsPatch: args.tools } : {}),
          ...(args.grantTools !== undefined ? { toolsGrant: args.grantTools } : {}),
        })
      } catch (e) {
        const err = e as { kind?: string; violations?: string[] }
        if (err.kind === 'agent_update_expanded') {
          return { text: `扩张被拒（总序 deny ≺ ask ≺ allow ≺ ignore，只许顺链收紧）：\n${(err.violations ?? []).map((v) => `  - ${v}`).join('\n')}` }
        }
        throw e
      }
      const cfg = kernel.lineage.nodeConfigOf(target)
      const modelEcho = cfg?.model !== undefined ? `${cfg.model.ref.provider}/${cfg.model.ref.id}·${cfg.model.origin}` : '-'
      return { text: `已更新 ${target}（下一轮送信生效；收缩已沿族谱下传重算）。现模型 = ${modelEcho}；生效清单见 agent_inspect。` }
    },
  }
}

/** 列出 agent 实例（缺省列出调用者所在空间）。 */
function agentList(kernel: Kernel): ToolCapability {
  return {
    id: 'agent_list',
    description: '列出 agent 实例（可选指定空间，缺省为调用者所在空间）。',
    accessKey: 'agent_list',
    kind: 'internal',
    category: 'system',
    parameters: {
      type: 'object',
      properties: { spaceId: { type: 'string', description: '空间 id（可选）' } },
    },
    execute: async (input, ctx) => {
      const spaceId = (input as { spaceId?: string }).spaceId ?? ctx.spaceId
      const agents = await kernel.instances.listBySpace(spaceId as never)
      const lines = agents.map((a) => `${a.id} (${a.displayName}) <${a.classRef}> parent=${a.parentId ?? '-'} [${a.status}]`)
      return { text: lines.length > 0 ? `agent 列表:\n${lines.join('\n')}` : '（当前空间无 agent）' }
    },
  }
}

/** 查看单个 agent 实例详情（含族谱）。 */
function agentInspect(kernel: Kernel): ToolCapability {
  return {
    id: 'agent_inspect',
    description: '查看单个 agent 实例详情：父/子/祖先链、状态、轮次、成本。',
    accessKey: 'agent_inspect',
    kind: 'internal',
    category: 'system',
    parameters: {
      type: 'object',
      properties: { agentId: { type: 'string', description: 'agent id（缺省为调用者）' } },
    },
    execute: async (input, ctx) => {
      const agentId = (input as { agentId?: string }).agentId ?? ctx.agentId
      const instance = await kernel.instances.get(agentId as never)
      const children = kernel.lineage.getChildren(instance.id)
      const ancestors = kernel.lineage.getAncestors(instance.id)
      const node = kernel.lineage.nodeConfigOf(agentId)
      const lines = [
        `agent ${instance.id} (${instance.displayName})`,
        `  class: ${instance.classRef}`,
        `  parent: ${instance.parentId ?? '（根）'}`,
        `  children: ${children.length > 0 ? children.join(', ') : '-'}`,
        `  ancestry: ${ancestors.length > 0 ? ancestors.join(' → ') : '（user0 根）'}`,
        `  status: ${instance.status}  turns: ${instance.turnCount}  cost: ${instance.totalCost}`,
        `  model: ${node?.model !== undefined ? `${node.model.ref.provider}/${node.model.ref.id}（${MODEL_ORIGIN_LABELS[node.model.origin]}）` : '（全链无锚——检查 config.user.model）'}`,
        `  access: ${formatEffectiveAccess(node?.access)}`,
      ]
      return { text: lines.join('\n') }
    },
  }
}

/** 查询祖先链。 */
function agentAncestry(kernel: Kernel): ToolCapability {
  return {
    id: 'agent_ancestry',
    description: '查询指定 agent 的祖先链（[父 → … → user0]，不含自身）。',
    accessKey: 'agent_ancestry',
    kind: 'internal',
    category: 'system',
    parameters: {
      type: 'object',
      properties: { agentId: { type: 'string', description: 'agent id（缺省为调用者）' } },
    },
    execute: async (input, ctx) => {
      const agentId = (input as { agentId?: string }).agentId ?? ctx.agentId
      const ancestors = kernel.lineage.getAncestors(agentId as never)
      return { text: ancestors.length > 0 ? `祖先链: ${ancestors.join(' → ')}` : `${agentId} 是族谱树根（user0）` }
    },
  }
}

/** 查询后代。 */
function agentDescendants(kernel: Kernel): ToolCapability {
  return {
    id: 'agent_descendants',
    description: '查询指定 agent 的全部后代（BFS 子树）。',
    accessKey: 'agent_descendants',
    kind: 'internal',
    category: 'system',
    parameters: {
      type: 'object',
      properties: { agentId: { type: 'string', description: 'agent id（缺省为调用者）' } },
    },
    execute: async (input, ctx) => {
      const agentId = (input as { agentId?: string }).agentId ?? ctx.agentId
      const descendants = kernel.lineage.getDescendants(agentId as never)
      return { text: descendants.length > 0 ? `后代: ${descendants.join(', ')}` : `${agentId} 无后代` }
    },
  }
}

/** 终止 agent 实例（销毁权校验：调用者须是目标的祖先或 user0）。 */
function agentTerminate(kernel: Kernel): ToolCapability {
  return {
    id: 'agent_terminate',
    description:
      '终止一个 agent 实例（注销上下文）。销毁权：仅该 agent 的祖先（含 user0）可销毁。默认禁止销毁仍有子 agent 的父；recursive=true 时级联销毁整棵子树。',
    accessKey: 'agent_terminate',
    kind: 'internal',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: '要终止的 agent id' },
        recursive: { type: 'boolean', description: '级联销毁子树（默认 false）' },
      },
      required: ['agentId'],
    },
    execute: async (input, ctx) => {
      const { agentId, recursive } = input as { agentId: string; recursive?: boolean }
      await kernel.terminateAgent(agentId, { by: ctx.agentId, recursive })
      return { text: `已终止 agent ${agentId}` }
    },
  }
}

/** 经总线发送消息（单目标；一对多通过并行多次调用实现）。 */
function busSend(kernel: Kernel): ToolCapability {
  return {
    id: 'bus_send',
    description: '向指定参与者发送消息（单目标，一对多请并行调用多次）。消息自动添加发送者戳。',
    accessKey: 'bus_send',
    kind: 'internal',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '目标参与者 id（agent id 或 user0）' },
        message: { type: 'string', description: '消息内容' },
      },
      required: ['to', 'message'],
    },
    execute: async (input, ctx) => {
      const { to, message } = input as { to: string; message: string }
      await kernel.sendMessage(ctx.agentId, to, message)
      return { text: `已发送消息给 ${to}` }
    },
  }
}

/** 查询总线注册参与者。 */
function busParticipants(kernel: Kernel): ToolCapability {
  return {
    id: 'bus_participants',
    description: '列出当前总线注册的参与者 id 列表。',
    accessKey: 'bus_participants',
    kind: 'internal',
    category: 'system',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const ids = await kernel.listParticipants()
      return { text: ids.length > 0 ? `参与者: ${ids.join(', ')}` : '（暂无参与者）' }
    },
  }
}

/**
 * 等待指定 agent 的回复（context 模块工具）。
 * 注册后，该 agent 的 assistant_message 将作为本工具的 tool 结果进入上下文（而非普通信件）。
 * 本工具无常规 tool 结果（metadata.contextWait 标记使 kernel 跳过记录）；
 * 真正的结果由邮局在等待对象回信时填充。
 */
function contextWait(kernel: Kernel): ToolCapability {
  return {
    id: 'context_wait',
    description:
      '等待指定 agent 的回复。配合 agent_instantiate 使用：创建子 agent 后调用 context_wait(agentId)（agentId 为 agent_instantiate 返回的 id），该 agent 的 assistant_message 将作为本工具的 tool 结果进入你的上下文，而不是作为普通来信。',
    accessKey: 'context_wait',
    kind: 'internal',
    category: 'context',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: '要等待其回复的 agent id（来自 agent_instantiate 的返回结果）' },
      },
      required: ['agentId'],
    },
    execute: async (input, ctx) => {
      const agentId = (input as { agentId: string }).agentId
      await kernel.contextManager.registerHold(agentId, { ownerId: ctx.agentId, toolCallId: ctx.callId ?? '' })
      return { text: '', metadata: { contextWait: true } }
    },
  }
}

/** 导出上下文为 jsonl（只读；agent 只能导出自己的上下文）。 */
function contextExport(kernel: Kernel): ToolCapability {
  return {
    id: 'context_export',
    description: '导出指定 agent 的完整上下文为 jsonl（逐行 JSON，含 tag/turn/indexInTurn）。只读，不修改上下文。',
    accessKey: 'context_export',
    kind: 'internal',
    category: 'context',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'agent id（缺省为调用者自身）' },
      },
    },
    execute: async (input, ctx) => {
      const agentId = (input as { agentId?: string }).agentId ?? ctx.agentId
      // 权限：agent 只能导出自己的上下文（或祖先）。
      if (!kernel.lineage.canReach(makeAgentID(ctx.agentId), makeAgentID(agentId))) {
        return { text: '无权导出该 agent 的上下文' }
      }
      const jsonl = await kernel.exportContext(agentId)
      return { text: jsonl === '' ? '（空上下文）' : jsonl }
    },
  }
}

/** 上下文概览（只读反射；agent 只能查看自己的上下文）。 */
function contextOverview(kernel: Kernel): ToolCapability {
  return {
    id: 'context_overview',
    description:
      '查看指定 agent 的上下文概览：每条消息的 role / turn / tag / token 占比 / 索引。只读反射，不修改上下文。用于 agent 自省上下文构成。',
    accessKey: 'context_overview',
    kind: 'internal',
    category: 'context',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'agent id（缺省为调用者自身）' },
      },
    },
    execute: async (input, ctx) => {
      const agentId = (input as { agentId?: string }).agentId ?? ctx.agentId
      if (!kernel.lineage.canReach(makeAgentID(ctx.agentId), makeAgentID(agentId))) {
        return { text: '无权查看该 agent 的上下文' }
      }
      return { text: await kernel.contextOverview(agentId) }
    },
  }
}

/** 删除上下文中的过时消息（标记无效，组装时跳过；删除后组装统一过 legalize 保证可经 gateway 发送）。 */
function contextRemove(kernel: Kernel): ToolCapability {
  return {
    id: 'context_remove',
    description:
      '删除指定 agent 上下文中的过时消息（标记无效，组装时跳过，不物理清除）。可删任意消息（system 除外）；删除后上下文经 legalize 保证消息序列合法。用于清理过时工具结果/过期总结等。',
    accessKey: 'context_remove',
    kind: 'internal',
    category: 'context',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: '目标 agent id（缺省为调用者自身；仅自身或祖先可删）' },
        messageIds: { type: 'array', items: { type: 'string' }, description: '要删除的消息 id 列表（来自 context_export/overview）' },
        turn: { type: 'number', description: '删除整轮（按轮号，优先级高于 messageIds）' },
      },
    },
    execute: async (input, ctx) => {
      const args = input as { agentId?: string; messageIds?: string[]; turn?: number }
      const target = args.agentId ?? ctx.agentId
      if (!kernel.lineage.canReach(makeAgentID(ctx.agentId), makeAgentID(target))) {
        return { text: '无权删除该 agent 的上下文' }
      }
      const state = await kernel.contextManager.getState(target)
      const ids = args.turn !== undefined ? state.messages.filter((m) => m.turn === args.turn).map((m) => m.id) : (args.messageIds ?? [])
      // system 消息不可删。
      const systemIds = new Set(state.messages.filter((m) => m.message.role === 'system').map((m) => m.id))
      const removable = ids.filter((id) => !systemIds.has(id))
      if (removable.length === 0) return { text: '无消息可删除（system 消息不可删）' }
      await kernel.repository.markInvalid(target, removable)
      return { text: `已删除 ${removable.length} 条消息（agent ${target}）` }
    },
  }
}

/** 重写上下文中的某条消息内容（保留 role/索引；改后组装过 legalize 保证合法）。 */
function contextEdit(kernel: Kernel): ToolCapability {
  return {
    id: 'context_edit',
    description: '重写指定 agent 上下文中的某条消息内容（保留 role/索引；system 消息不可改）。',
    accessKey: 'context_edit',
    kind: 'internal',
    category: 'context',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: '目标 agent id（缺省为调用者自身；仅自身或祖先可改）' },
        messageId: { type: 'string', description: '消息 id（来自 context_export/overview）' },
        content: { type: 'string', description: '新内容' },
      },
      required: ['messageId', 'content'],
    },
    execute: async (input, ctx) => {
      const args = input as { agentId?: string; messageId: string; content: string }
      const target = args.agentId ?? ctx.agentId
      if (!kernel.lineage.canReach(makeAgentID(ctx.agentId), makeAgentID(target))) {
        return { text: '无权修改该 agent 的上下文' }
      }
      const state = await kernel.contextManager.getState(target)
      const stored = state.messages.find((m) => m.id === args.messageId)
      if (!stored) return { text: `消息不存在: ${args.messageId}` }
      if (stored.message.role === 'system') return { text: 'system 消息不可修改' }
      await kernel.repository.updateMessage(target, args.messageId, { ...stored.message, content: args.content })
      return { text: `已更新消息 ${args.messageId}` }
    },
  }
}

/** 执行上下文策略专有动作（策略独立接口的模型侧通道；agent 只能操作自身，祖先可代操作）。 */
function contextApply(kernel: Kernel): ToolCapability {
  return {
    id: 'context_apply',
    description:
      '执行该 agent 上下文管理策略的专有动作（如 classic 的 compact 手动压缩历史）。action 取值见系统提示中的 <stem_context>。仅能操作自身上下文（祖先可代子孙触发）。',
    accessKey: 'context_apply',
    kind: 'internal',
    category: 'context',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: '目标 agent id（缺省为调用者自身；仅自身或祖先可操作）' },
        action: { type: 'string', description: '策略动作名（如 compact）' },
        args: { type: 'string', description: '动作参数（策略自定义，可选）' },
      },
      required: ['action'],
    },
    execute: async (input, ctx) => {
      const args = input as { agentId?: string; action: string; args?: string }
      const target = args.agentId ?? ctx.agentId
      if (!kernel.lineage.canReach(makeAgentID(ctx.agentId), makeAgentID(target))) {
        return { text: '无权操作该 agent 的上下文策略' }
      }
      const result = await kernel.contextManager.runStrategyAction(target, args.action, args.args ?? '')
      return { text: result }
    },
  }
}

/** 批准/拒绝访问申请（ask 消息化的回复侧；授权权：仅申请者的族谱根可调用）。 */
function accessReply(kernel: Kernel): ToolCapability {
  return {
    id: 'access_reply',
    description:
      '批准或拒绝访问申请。请求以 access_request 消息形式到达你的信箱（含 requestId / 申请工具 / 申请 agent）；用本工具回复 once（单次）/ always（始终批准）/ reject（拒绝，可带 feedback 告知申请 agent）。授权权：仅申请者的族谱根可答复。',
    accessKey: 'access_reply',
    kind: 'internal',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: '访问申请 id（来自信箱中的 access_request 消息）' },
        reply: { type: 'string', enum: ['once', 'always', 'reject'], description: 'once=单次 / always=始终 / reject=拒绝' },
        feedback: { type: 'string', description: 'reject 时的反馈（告知申请 agent）' },
      },
      required: ['requestId', 'reply'],
    },
    execute: async (input, ctx) => {
      const args = input as { requestId: string; reply: AccessReply; feedback?: string }
      await kernel.access.reply(
        {
          requestId: args.requestId,
          reply: args.reply,
          ...(args.feedback !== undefined ? { message: args.feedback } : {}),
        },
        ctx.agentId,
      )
      return { text: `已回复访问申请 ${args.requestId}: ${args.reply}` }
    },
  }
}

/**
 * 运行日志观测（S5.2 进化观测面，方案 §4.1）：telemetry 类目 internal 工具，
 * 缺省 ignore（隐藏但可用——评估者类显式声明才可见）。可见域 = **树位置函数**：
 * 自身 ∪ 祖先代查（后代可查、兄弟不可见、根天然全视），与 context_* 工具同一
 * canReach 谓词。行式压缩输出（控制 token 面）。
 */
function telemetryQuery(kernel: Kernel): ToolCapability {
  return {
    id: 'telemetry_query',
    description:
      '查询系统运行日志（telemetry 观测面）：工具调用/模型请求/信箱活动/权限交互/上下文动作/类注册与书写审计。可查自身或族谱后代（你是其祖先）；行式压缩输出。进化回路的"观测"支柱。',
    accessKey: 'telemetry_query',
    kind: 'internal',
    category: 'telemetry',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: '目标 agent id（缺省 = 调用者自身；后代可查）' },
        types: { type: 'array', items: { type: 'string' }, description: "事件类型过滤（如 'tool.invoked'；支持 'gateway.*' 前缀通配）" },
        since: { type: 'number', description: '起始时间戳（毫秒，含）' },
        until: { type: 'number', description: '截止时间戳（毫秒，含）' },
        limit: { type: 'number', description: '返回条数上限（缺省 50，硬顶 200；取最近 N 条）' },
      },
    },
    execute: async (input, ctx) => {
      const args = input as { agentId?: string; types?: string[]; since?: number; until?: number; limit?: number }
      const target = args.agentId ?? ctx.agentId
      if (!kernel.lineage.canReach(makeAgentID(ctx.agentId), makeAgentID(target))) {
        return { text: `无权查看该 agent 的运行日志（可见域 = 自身 + 族谱后代）: ${target}` }
      }
      const limit = Math.min(Math.max(args.limit ?? 50, 1), 200)
      const patterns = args.types ?? []
      const matches = (event: LogEvent): boolean => {
        if (!eventInvolvesAgent(event, target)) return false
        if (patterns.length > 0 && !patterns.some((p) => (p.endsWith('*') ? event.type.startsWith(p.slice(0, -1)) : event.type === p))) {
          return false
        }
        if (args.since !== undefined && event.at < args.since) return false
        if (args.until !== undefined && event.at > args.until) return false
        return true
      }
      const events = kernel.logger.all().filter(matches)
      if (events.length === 0) return { text: '(no events)' }
      const shown = events.slice(-limit)
      const header = `${target} | ${shown.length} 条${events.length > shown.length ? `（最近 ${shown.length} 条，共匹配 ${events.length}）` : ''}`
      return { text: `${header}\n${shown.map(formatTelemetryRow).join('\n')}` }
    },
  }
}

/** 单事件 → 行式压缩（`时刻 | 类型 | 摘要`；摘要按类型取关键字段，不 dump 大负载）。 */
export function formatTelemetryRow(event: LogEvent): string {
  const time = new Date(event.at).toISOString().slice(11, 23)
  return `${time} | ${event.type} | ${telemetryBrief(event)}`
}

function telemetryBrief(event: LogEvent): string {
  switch (event.type) {
    case 'tool.invoked':
      return `${event.tool} ${event.phase}${event.durationMs !== undefined ? ` ${event.durationMs}ms` : ''}${event.errorKind !== undefined ? ` [${event.errorKind}]` : ''}`
    case 'gateway.apiRequest':
      return `${event.provider}/${event.model} tok=${event.promptTokens ?? '-'}/${event.completionTokens ?? '-'} cost=${event.cost.toFixed(4)} ${event.latencyMs}ms`
    case 'context.assembled':
      return `assemble=${event.assemble} n=${event.messageCount}`
    case 'context.compacted':
      return `${event.outcome} n=${event.compactedCount}`
    case 'mailbox.countdown':
      return event.action
    case 'mailbox.delivered':
      return `${event.kind} n=${event.messageCount}`
    case 'kernel.class.registered':
      return `class=${event.classId}${event.persisted === undefined ? '' : event.persisted ? ' persisted' : ' in-memory'}`
    case 'kernel.class.updated':
      return `class=${event.classId} patch=${event.patch} ${event.persisted ? 'persisted' : 'in-memory'}`
    case 'kernel.instance.created':
      return `class=${event.classId} parent=${event.parentId === '' ? 'root' : event.parentId}`
    case 'kernel.status.changed':
      return `${event.from}→${event.to}`
    case 'kernel.instance.terminated':
      return 'terminated'
    case 'kernel.instance.updated':
      return `by=${event.by} fields=[${event.fields.join(',')}]`
    case 'kernel.model.set':
      return `model→${event.provider}/${event.model}${event.by !== undefined ? ` by=${event.by}` : ''}`
    case 'kernel.instance.interrupted':
      return `${event.aborted ? 'abort' : 'error'} ${event.message}`
    case 'kernel.message.sent':
      return `${event.from}→${event.to} ${event.kind} ${event.payloadSize}B`
    case 'access.asked':
      return `${event.accessKey} ${event.action}`
    case 'access.replied':
      return `${event.accessKey} ${event.reply}`
    case 'init.tool.registered':
      return `tool=${event.tool} file=${event.file}`
    case 'init.agent.registered':
      return `class=${event.classId} file=${event.file}`
    default:
      return JSON.stringify(event).slice(0, 160)
  }
}

/** 格式化生效访问（权限台账物化出示：显式判定 + 本地封闭/不设限）。 */
function formatEffectiveAccess(profile: AccessProfile | undefined): string {
  if (!profile) return '（未绑定）'
  const entries = Object.entries(profile.explicit).map(([k, v]) => `${k}:${v}`)
  const fallback = profile.fallback !== undefined ? `*: ${profile.fallback}` : '*: default'
  return entries.length > 0 ? `${entries.join(', ')}  |  ${fallback}` : fallback
}
