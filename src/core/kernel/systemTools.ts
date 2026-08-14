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
import type { Kernel } from './Kernel'
import type { AgentClass } from './types'
import { makeAgentClassID } from './types'

/** 生成系统工具清单（由 Kernel.registerSystemTools 装配）。 */
export function createSystemTools(kernel: Kernel): ToolCapability[] {
  return [
    agentClassCreate(kernel),
    agentClassList(kernel),
    agentInstantiate(kernel),
    agentList(kernel),
    agentInspect(kernel),
    agentAncestry(kernel),
    agentDescendants(kernel),
    agentTerminate(kernel),
    busSend(kernel),
    busParticipants(kernel),
    contextWait(kernel),
  ]
}

/** 创建新 agent 类（admin 权限，D7/铁律 8）。只承载类属性，不含实例数据（userPrompt 等）。 */
function agentClassCreate(kernel: Kernel): ToolCapability {
  return {
    id: 'agent_class_create',
    description:
      '创建新的 agent 类（模板）。类定义角色设定（systemPrompt/toolAccess 工具访问列表/工具白名单/模型/送信倒计时），不包含任何实例化数据（如 userPrompt）；实例化请用 agent_instantiate。toolAccess 为工具访问键到 allow/ask/deny/ignore 的映射，未列出的工具默认 ask（交用户确认）；internal 系统工具默认 ignore（隐藏，显式 allow 才暴露）。',
    accessKey: 'agent_class_create',
    kind: 'internal',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '类 id（唯一，kebab-case）' },
        name: { type: 'string', description: '类名，如 "Coder"' },
        description: { type: 'string', description: '类用途描述' },
        systemPrompt: { type: 'string', description: '该类的专属系统提示词' },
        toolAccess: { type: 'object', description: '工具访问列表：访问键 → allow/ask/deny/ignore（未列出的默认 ask）' },
        tools: { type: 'array', items: { type: 'string' }, description: '工具 id 白名单（缺省=允许的全部工具）' },
        model: { type: 'string', description: '模型 id（可选，缺省用系统默认模型）' },
        sendCountdown: { type: 'number', description: '送信倒计时毫秒（可选，缺省 1000）' },
      },
      required: ['id', 'name', 'description', 'systemPrompt'],
    },
    execute: async (input) => {
      const args = input as {
        id: string
        name: string
        description: string
        systemPrompt: string
        toolAccess?: Readonly<Record<string, ToolAccess>>
        tools?: string[]
        model?: string
        sendCountdown?: number
      }
      const cls: AgentClass = {
        id: makeAgentClassID(args.id),
        name: args.name,
        description: args.description,
        systemPrompt: args.systemPrompt,
        toolAccess: args.toolAccess ?? {},
        tools: (args.tools ?? []).map((id) => ({ id })),
        memoryScope: [],
        model: args.model ? { provider: 'opencode', id: args.model } : undefined,
        sendCountdown: args.sendCountdown,
      }
      await kernel.registerAgentClass(cls)
      return { text: `已创建 agent 类 ${args.id}（${args.name}，toolAccess=${Object.keys(cls.toolAccess).length} 条规则）` }
    },
  }
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
          `${c.id}  ${c.name}  tools=${c.tools.length > 0 ? c.tools.map((t) => t.id).join(',') : '-'}  access=${Object.entries(c.toolAccess)
            .map(([t, a]) => `${t}:${a}`)
            .join(',') || '-'}${c.model ? `  model=${c.model.id}` : ''}`,
      )
      return { text: lines.length > 0 ? `agent 类列表:\n${lines.join('\n')}` : '（暂无 agent 类）' }
    },
  }
}

/** 创建 agent 实例（必填 userPrompt；creatorId 缺省为调用者 id）。 */
function agentInstantiate(kernel: Kernel): ToolCapability {
  return {
    id: 'agent_instantiate',
    description:
      '创建新的 agent 实例。必填 classId 与 userPrompt（作为该 agent 的首条 user 消息）；creatorId 缺省为调用者自身；新实例的族谱父为调用者。创建后 agent 自动注册到总线与邮局，返回其 agent id。若需等待该 agent 的返回结果，请在收到 id 后调用 context_wait(agentId)。',
    accessKey: 'agent_instantiate',
    kind: 'internal',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        classId: { type: 'string', description: 'Agent 模板 id' },
        userPrompt: { type: 'string', description: '实例化时附带的 user prompt（必填）' },
        creatorId: { type: 'string', description: '创建者 id（缺省为调用者）' },
        agentId: { type: 'string', description: '指定新 agent 的 id（可选，缺省随机生成）' },
        displayName: { type: 'string', description: '展示名（可选）' },
      },
      required: ['classId', 'userPrompt'],
    },
    execute: async (input, ctx) => {
      const args = input as { classId: string; userPrompt: string; creatorId?: string; agentId?: string; displayName?: string }
      const agentId = await kernel.instantiateInSpace(
        {
          classId: makeAgentClassID(args.classId),
          userPrompt: args.userPrompt,
          creatorId: args.creatorId ?? ctx.agentId,
          id: args.agentId,
          displayName: args.displayName,
        },
        ctx.spaceId,
      )
      return { text: `已创建 agent ${agentId}` }
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
      const lines = [
        `agent ${instance.id} (${instance.displayName})`,
        `  class: ${instance.classRef}`,
        `  parent: ${instance.parentId ?? '（根）'}`,
        `  children: ${children.length > 0 ? children.join(', ') : '-'}`,
        `  ancestry: ${ancestors.length > 0 ? ancestors.join(' → ') : '（user0 根）'}`,
        `  status: ${instance.status}  turns: ${instance.turnCount}  cost: ${instance.totalCost}`,
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
