// ============================================================
// core/kernel/systemTools.ts —— 系统管理工具（Kernel 提供）
//
// 权限分级（铁律 8）：agent_* = advanced；bus_* = normal。
// 工具执行器闭包引用 AgentKernel（组合根装配时注册到工具注册表）。
// 命名规范：`<模块>_<动作>`（bus_send / bus_participants / agent_*）。
// ============================================================

import type { ToolCapability } from '../tools'
import type { AgentKernel } from './AgentKernel'
import { makeAgentClassID } from './types'

/** 生成系统工具清单（由 AgentKernel.registerSystemTools 装配）。 */
export function createSystemTools(kernel: AgentKernel): ToolCapability[] {
  return [
    agentInstantiate(kernel),
    agentList(kernel),
    agentTerminate(kernel),
    busSend(kernel),
    busParticipants(kernel),
    contextWait(kernel),
  ]
}

/** 创建 agent 实例（必填 userPrompt；creatorId 缺省为调用者 id）。 */
function agentInstantiate(kernel: AgentKernel): ToolCapability {
  return {
    id: 'agent_instantiate',
    description:
      '创建新的 agent 实例。必填 classId 与 userPrompt（作为该 agent 的首条 user 消息）；creatorId 缺省为调用者自身。创建后 agent 自动注册到总线与邮局，返回其 agent id。若需等待该 agent 的返回结果，请在收到 id 后调用 context_wait(agentId)。',
    permission: 'advanced',
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
function agentList(kernel: AgentKernel): ToolCapability {
  return {
    id: 'agent_list',
    description: '列出 agent 实例（可选指定空间，缺省为调用者所在空间）。',
    permission: 'advanced',
    category: 'system',
    parameters: {
      type: 'object',
      properties: { spaceId: { type: 'string', description: '空间 id（可选）' } },
    },
    execute: async (input, ctx) => {
      const spaceId = (input as { spaceId?: string }).spaceId ?? ctx.spaceId
      const agents = await kernel.instances.listBySpace(spaceId as never)
      const lines = agents.map((a) => `${a.id} (${a.displayName}) <${a.classRef}> [${a.status}]`)
      return { text: lines.length > 0 ? `agent 列表:\n${lines.join('\n')}` : '（当前空间无 agent）' }
    },
  }
}

/** 终止 agent 实例。 */
function agentTerminate(kernel: AgentKernel): ToolCapability {
  return {
    id: 'agent_terminate',
    description: '终止一个 agent 实例（注销总线与邮局）。',
    permission: 'advanced',
    category: 'system',
    parameters: {
      type: 'object',
      properties: { agentId: { type: 'string', description: '要终止的 agent id' } },
      required: ['agentId'],
    },
    execute: async (input) => {
      const agentId = (input as { agentId: string }).agentId
      await kernel.terminateAgent(agentId)
      return { text: `已终止 agent ${agentId}` }
    },
  }
}

/** 经总线发送消息（单目标；一对多通过并行多次调用实现）。 */
function busSend(kernel: AgentKernel): ToolCapability {
  return {
    id: 'bus_send',
    description: '通过总线向指定参与者发送消息（单目标，一对多请并行调用多次）。消息自动添加发送者戳。',
    permission: 'normal',
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
      const stamped = `<sender id="${ctx.agentId}">${message}</sender>`
      await kernel.bus.send({ kind: 'agent_message', from: ctx.agentId, to, payload: stamped, at: Date.now() })
      return { text: `已发送消息给 ${to}` }
    },
  }
}

/** 查询总线注册参与者。 */
function busParticipants(kernel: AgentKernel): ToolCapability {
  return {
    id: 'bus_participants',
    description: '列出当前总线注册的参与者 id 列表。',
    permission: 'normal',
    category: 'system',
    parameters: { type: 'object', properties: {} },
    execute: () => {
      const ids = kernel.bus.listParticipants().map((p) => p.id)
      return { text: ids.length > 0 ? `总线参与者: ${ids.join(', ')}` : '（总线暂无参与者）' }
    },
  }
}

/**
 * 等待指定 agent 的回复（context 模块工具）。
 * 注册后，该 agent 的 assistant_message 将作为本工具的 tool 结果进入上下文（而非普通信件）。
 * 本工具无常规 tool 结果（metadata.contextWait 标记使 kernel 跳过记录）；
 * 真正的结果由邮局在等待对象回信时填充。
 */
function contextWait(kernel: AgentKernel): ToolCapability {
  return {
    id: 'context_wait',
    description:
      '等待指定 agent 的回复。配合 agent_instantiate 使用：创建子 agent 后调用 context_wait(agentId)（agentId 为 agent_instantiate 返回的 id），该 agent 的 assistant_message 将作为本工具的 tool 结果进入你的上下文，而不是作为普通来信。',
    permission: 'normal',
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
