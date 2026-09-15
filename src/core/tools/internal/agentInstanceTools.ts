// ============================================================
// core/tools/internal/agentInstanceTools.ts —— agent 实例生命周期工具
//
// 注册即出生声明；消费方拥有端口（./ports），零 kernel import。
// ============================================================

import type { ToolCapability, ToolAccess } from '../types'
import type { ModelRef } from '../../gateway'
import { parseModelRef } from '../../gateway'
import type { SystemToolHost } from './ports'
import { MODEL_FORMAT_HINT, MODEL_ORIGIN_LABELS, resolveOr, resolveReachable, formatEffectiveAccess } from './shared'

export function agentInstantiate(host: SystemToolHost): ToolCapability {
  return {
    id: 'agent_instantiate',
    description:
      '创建新的 agent 实例。必填 className（模板名）与 userPrompt（作为该 agent 的首条 user 消息）；族谱父自动为调用者。可选 name（出生称呼，全局唯一，撞名拒绝并明示；缺省确定性派生 `类名-N`——id 是出生路径由系统全托管，不接受指定）、model（"提供商/模型" 显式覆盖出生模型；缺省 = 类基因 > 你的继承链）、contextRefs（父仓库消息索引，深拷贝传入）、tools（对模板工具清单的临时收敛）。创建即返回新实例全名 `name#id`。' +
      'wait=true 时同步等待该 agent 的回信作为本次调用的结果进入你的上下文（创建与配对原子完成，回信不会漏接；可配 waitTimeoutMs 超时兜底）；不传 wait = 异步协作，其回复将作为普通信件到达。',
    accessKey: 'agent_instantiate',
    birth: 'ignore', // 出生声明（agent_instantiate）
    kind: 'internal',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        className: { type: 'string', description: 'Agent 模板名' },
        userPrompt: { type: 'string', description: '实例化时附带的 user prompt（必填）' },
        name: { type: 'string', description: '出生称呼（可选，全局唯一；撞名被拒不自动后缀。缺省派生 `类名-N`。id 是出生路径，系统全托管）' },
        model: { type: 'string', description: '显式模型 "提供商/模型"（可选；缺省按 类基因>父继承>家学 解析）' },
        contextRefs: { type: 'array', items: { type: 'string' }, description: '父仓库消息索引列表（消息 id 或轮索引），深拷贝传入新实例' },
        tools: { type: 'object', description: '工具清单补充：访问键 → ask/deny（对模板表临时收敛）' },
        wait: { type: 'boolean', description: 'true = 创建并等待该 agent 回信作为本工具结果（推荐用于子任务委托）' },
        waitTimeoutMs: { type: 'number', description: 'wait 超时毫秒（可选；超时回填提示行，不无限等待）' },
      },
      required: ['className', 'userPrompt'],
    },
    execute: async (input, ctx) => {
      const args = input as {
        className: string
        userPrompt: string
        name?: string
        model?: string
        contextRefs?: string[]
        tools?: Readonly<Record<string, ToolAccess>>
        wait?: boolean
        waitTimeoutMs?: number
      }
      let model: ModelRef | undefined
      if (args.model !== undefined) {
        const parsed = parseModelRef(args.model)
        if (parsed === undefined) return { text: MODEL_FORMAT_HINT }
        model = parsed
      }
      let agentId: string
      try {
        agentId = await host.agents.instantiate(
          {
            className: args.className,
            userPrompt: args.userPrompt,
            parentId: ctx.agentId,
            ...(args.name !== undefined ? { name: args.name } : {}),
            contextRefs: args.contextRefs,
            tools: args.tools,
            ...(model !== undefined ? { model } : {}),
            // wait：hold 随实例化原子注册（kernel 在首信投递前放置，竞态绝迹）；
            // 本调用不回填结果，runtime 见 contextWait 标记收束本轮等唤醒。
            ...(args.wait === true
              ? { hold: { toolCallId: ctx.callId ?? '', ...(args.waitTimeoutMs !== undefined ? { timeoutMs: args.waitTimeoutMs } : {}) } }
              : {}),
          },
        )
      } catch (cause) {
        const err = cause as { kind?: string; violations?: string[]; message?: string }
        if (err?.kind === 'tools_convergence_expanded') {
          return {
            text:
              `工具清单收敛被拒（逐键只许沿 ignore→allow→ask→deny 收紧，出生声明与父面显式判定封顶）：\n` +
              (err.violations ?? []).map((v) => `  - ${v}`).join('\n'),
          }
        }
        if (err?.kind === 'agent_name_conflict') {
          return { text: `称呼冲突：${err.message ?? String(cause)}——换一个 name，或省略 name 用派生称呼` }
        }
        throw cause
      }
      if (args.wait === true) {
        return { text: '', metadata: { contextWait: true } }
      }
      return { text: `已创建 agent ${host.agents.displayOf(agentId)}` }
    },
  }
}

/**
 * 运行时换模型（S6/R7：模型自由三环之一——实例化可选 / 类基因 / 本通道随时调整）。
 * internal 缺省 ignore（白名单显式赋权），授权 = 树可见域 canReach（自身∨后代，
 * 无特权通道）；改后下一轮送信生效，**不级联**已出生子孙（R6 族规=出生快照）；
 * 显式层随实例行落盘（R14，重启延续）。provider 未接通/模型不在白名单 → 用到才硬错。
 */
export function agentUpdate(host: SystemToolHost): ToolCapability {
  return {
    id: 'agent_update',
    description:
      '更新 agent 实例的运行参数（缺省目标 = 你自己；祖先可改后代）。' +
      'model = "提供商/模型"（下一轮生效，不级联已出生子孙；随实例持久化）。' +
      'name = 实例称呼（全局唯一，撞名拒绝）。' +
      '类定义/父子拓扑/上下文策略/系统提示/工具清单不在本通道——改类走 agent_class_update；' +
      '工具清单出生时收敛落地后不可改。',
    accessKey: 'agent_update',
    birth: 'ignore', // 出生声明（agent_update）
    kind: 'internal',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: '目标（可选，缺省为调用者自身；name / name#id / id 三形态）；仅自身或祖先可改' },
        model: { type: 'string', description: '新模型 "提供商/模型"（可选）' },
        name: { type: 'string', description: '新称呼（全局唯一，撞名被拒）' },
      },
    },
    execute: async (input, ctx) => {
      const args = input as {
        agentId?: string
        model?: string
        name?: string
      }
      const resolved = resolveReachable(host, ctx.agentId, args.agentId, (id) => `无权更新该 agent（可见域 = 自身 + 族谱后代）: ${id}`)
      if ('text' in resolved) return { text: resolved.text }
      const target = resolved.id
      let model: ModelRef | undefined
      if (args.model !== undefined) {
        const parsed = parseModelRef(args.model)
        if (parsed === undefined) return { text: MODEL_FORMAT_HINT }
        model = parsed
      }
      if (model === undefined && args.name === undefined) {
        return { text: '至少给出一个更新字段（model / name）；现档案见 agent_inspect' }
      }
      try {
        await host.agents.updateAgent({
          agentId: target,
          by: ctx.agentId,
          ...(model !== undefined ? { model } : {}),
          ...(args.name !== undefined ? { name: args.name } : {}),
        })
      } catch (e) {
        const err = e as { kind?: string; message?: string }
        if (err.kind === 'agent_name_conflict') return { text: `改名被拒：${err.message ?? String(e)}` }
        throw e
      }
      const cfg = host.agents.getAgentConfig(target)
      const modelEcho = cfg?.model !== undefined ? `${cfg.model.ref.provider}/${cfg.model.ref.id}·${cfg.model.origin}` : '-'
      return { text: `已更新 ${host.agents.displayOf(target)}（下一轮送信生效）。现模型 = ${modelEcho}。` }
    },
  }
}

/** 列出 agent 实例（单空间全量）。 */
export function agentList(host: SystemToolHost): ToolCapability {
  return {
    id: 'agent_list',
    description: '列出全部 agent 实例。',
    accessKey: 'agent_list',
    birth: 'ignore', // 出生声明（agent_list）
    kind: 'internal',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      const agents = await host.agents.listInstances()
      const lines = agents.map((a) => `${a.name}#${a.id} <${a.classRef}> parent=${a.parentId ?? '-'} [${a.status}]`)
      return { text: lines.length > 0 ? `agent 列表:\n${lines.join('\n')}` : '（无 agent）' }
    },
  }
}

/** 查看单个 agent 实例详情（含族谱）。 */
export function agentInspect(host: SystemToolHost): ToolCapability {
  return {
    id: 'agent_inspect',
    description: '查看单个 agent 实例详情：父/子/祖先链、状态、轮次、成本。',
    accessKey: 'agent_inspect',
    birth: 'ignore', // 出生声明（agent_inspect）
    kind: 'internal',
    category: 'system',
    parameters: {
      type: 'object',
      properties: { agentId: { type: 'string', description: '目标（name / name#id / id；缺省为调用者）' } },
    },
    execute: async (input, ctx) => {
      const ref = (input as { agentId?: string }).agentId ?? ctx.agentId
      const resolved = resolveOr(host, ref)
      if ('text' in resolved) return { text: resolved.text }
      const agentId = resolved.id
      const instance = await host.agents.getInstance(agentId)
      const children = host.agents.getChildren(instance.id)
      const ancestors = host.agents.getAncestors(instance.id)
      const node = host.agents.getAgentConfig(agentId)
      const lines = [
        `agent ${instance.name}#${instance.id}`,
        `  class: ${instance.classRef}`,
        `  parent: ${instance.parentId !== null ? host.agents.displayOf(instance.parentId) : '（根）'}`,
        `  children: ${children.length > 0 ? children.map((id) => host.agents.displayOf(id)).join(', ') : '-'}`,
        `  ancestry: ${ancestors.length > 0 ? ancestors.map((id) => host.agents.displayOf(id)).join(' → ') : '（树根）'}`,
        `  status: ${instance.status}  turns: ${instance.turnCount}  cost: ${instance.totalCost}`,
        `  model: ${node?.model !== undefined ? `${node.model.ref.provider}/${node.model.ref.id}（${MODEL_ORIGIN_LABELS[node.model.origin] ?? node.model.origin}）` : '（全链无锚——检查 config.user.model）'}`,
        `  access: ${formatEffectiveAccess(node?.access)}`,
      ]
      return { text: lines.join('\n') }
    },
  }
}

/** 查询祖先链。 */
export function agentAncestry(host: SystemToolHost): ToolCapability {
  return {
    id: 'agent_ancestry',
    description: '查询指定 agent 的祖先链（[父 → … → 根]，不含自身）。',
    accessKey: 'agent_ancestry',
    birth: 'ignore', // 出生声明（agent_ancestry）
    kind: 'internal',
    category: 'system',
    parameters: {
      type: 'object',
      properties: { agentId: { type: 'string', description: '目标（name / name#id / id；缺省为调用者）' } },
    },
    execute: async (input, ctx) => {
      const ref = (input as { agentId?: string }).agentId ?? ctx.agentId
      const resolved = resolveOr(host, ref)
      if ('text' in resolved) return { text: resolved.text }
      const ancestors = host.agents.getAncestors(resolved.id)
      return { text: ancestors.length > 0 ? `祖先链: ${ancestors.map((id) => host.agents.displayOf(id)).join(' → ')}` : `${host.agents.displayOf(resolved.id)} 是族谱树根` }
    },
  }
}

/** 查询后代。 */
export function agentDescendants(host: SystemToolHost): ToolCapability {
  return {
    id: 'agent_descendants',
    description: '查询指定 agent 的全部后代（BFS 子树）。',
    accessKey: 'agent_descendants',
    birth: 'ignore', // 出生声明（agent_descendants）
    kind: 'internal',
    category: 'system',
    parameters: {
      type: 'object',
      properties: { agentId: { type: 'string', description: '目标（name / name#id / id；缺省为调用者）' } },
    },
    execute: async (input, ctx) => {
      const ref = (input as { agentId?: string }).agentId ?? ctx.agentId
      const resolved = resolveOr(host, ref)
      if ('text' in resolved) return { text: resolved.text }
      const descendants = host.agents.getDescendants(resolved.id)
      return { text: descendants.length > 0 ? `后代: ${descendants.map((id) => host.agents.displayOf(id)).join(', ')}` : `${host.agents.displayOf(resolved.id)} 无后代` }
    },
  }
}

/** 终止 agent 实例（销毁权校验：调用者须是目标的祖先）。 */
export function agentTerminate(host: SystemToolHost): ToolCapability {
  return {
    id: 'agent_terminate',
    description:
      '终止一个 agent 实例（注销上下文；地址与称呼进墓碑永不回收）。销毁权：仅该 agent 的祖先可销毁。默认禁止销毁仍有子 agent 的父；recursive=true 时级联销毁整棵子树。',
    accessKey: 'agent_terminate',
    birth: 'ignore', // 出生声明（agent_terminate）
    kind: 'internal',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: '要终止的目标（name / name#id / id）' },
        recursive: { type: 'boolean', description: '级联销毁子树（默认 false）' },
      },
      required: ['agentId'],
    },
    execute: async (input, ctx) => {
      const { agentId, recursive } = input as { agentId: string; recursive?: boolean }
      const resolved = resolveOr(host, agentId)
      if ('text' in resolved) return { text: resolved.text }
      await host.agents.terminateAgent(resolved.id, { by: ctx.agentId, recursive })
      return { text: `已终止 agent ${host.agents.displayOf(resolved.id)}` }
    },
  }
}

/** 邮寄消息（单目标；一对多通过并行多次调用实现）。 */
