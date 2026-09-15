// ============================================================
// core/kernel/toolHost.ts —— SystemToolHost 适配器（kernel 侧实现）
//
// 端口倒置的实现面：tools/internal 声明窄端口（消费方拥有），kernel 把自身
// 的域操作适配成中性 DTO，组合根注入。kernel → tools 是既定的单向依赖，
// 本文件不引入 tools → kernel 反向依赖。
// ============================================================

import type {
  AccessPort,
  AgentClassView,
  AgentConfigView,
  AgentInstanceView,
  AgentPort,
  ContextPort,
  SystemToolHost,
  TelemetryPort,
} from '../tools/internal/ports'
import type { AccessProfile } from '../lineage'
import type { AgentClass, AgentInstance } from './types'
import { makeAgentClassID, makeAgentID, parentIdOf } from './types'
import { pickAgentClassGenes } from './attributes'
import type { Kernel } from './Kernel'

function toInstanceView(instance: AgentInstance): AgentInstanceView {
  return {
    id: instance.id,
    name: instance.name,
    classRef: instance.classRef,
    parentId: parentIdOf(instance.id),
    status: instance.status,
    turnCount: instance.turnCount,
    totalCost: instance.totalCost,
    totalTokens: instance.totalTokens,
  }
}

function toClassView(cls: AgentClass): AgentClassView {
  return {
    name: cls.name,
    description: cls.description,
    ...pickAgentClassGenes(cls),
  }
}

function toAccessView(access: AccessProfile | undefined): AgentConfigView['access'] {
  if (access === undefined) return undefined
  return { explicit: access.explicit, ...(access.fallback !== undefined ? { fallback: access.fallback } : {}) }
}

/** 由 Kernel 构造 SystemToolHost 适配器（组合根接线用）。 */
export function createSystemToolHost(kernel: Kernel): SystemToolHost {
  const agents: AgentPort = {
    resolveAgent: (ref) => kernel.resolveAgent(ref),
    displayOf: (agentId) => kernel.displayOf(agentId),
    canReach: (by, target) => kernel.lineage.canReach(makeAgentID(by), makeAgentID(target)),
    listParticipants: () => kernel.listParticipants(),
    sendMessage: (from, to, payload) => kernel.sendMessage(from, to, payload),

    listClasses: async () => (await kernel.templates.list()).map(toClassView),
    getClassSync: (name) => {
      const cls = kernel.templates.getSync(makeAgentClassID(name))
      return cls !== undefined ? toClassView(cls) : undefined
    },
    registerAgentClass: (cls, opts) =>
      kernel.registerAgentClass(
        {
          name: makeAgentClassID(cls.name),
          description: cls.description,
          systemPrompt: cls.systemPrompt,
          ...pickAgentClassGenes(cls),
        },
        opts,
      ),
    updateAgentClass: (name, patch, opts) => kernel.updateAgentClass(makeAgentClassID(name), patch, opts),
    hasClassStore: () => kernel.hasClassStore(),

    instantiate: (req) =>
      kernel.instantiateInSpace({
        className: makeAgentClassID(req.className),
        userPrompt: req.userPrompt,
        parentId: req.parentId === null ? null : makeAgentID(req.parentId),
        ...(req.name !== undefined ? { name: req.name } : {}),
        ...(req.model !== undefined ? { model: req.model } : {}),
        ...(req.contextRefs !== undefined ? { contextRefs: req.contextRefs } : {}),
        ...(req.tools !== undefined ? { tools: req.tools } : {}),
        ...(req.hold !== undefined ? { hold: req.hold } : {}),
      }),
    updateAgent: (req) => kernel.updateAgent(req),
    terminateAgent: (agentId, opts) => kernel.terminateAgent(agentId, opts),

    listInstances: async () => (await kernel.instances.listAll()).map(toInstanceView),
    getInstance: async (agentId) => toInstanceView(await kernel.instances.get(makeAgentID(agentId))),
    getInstanceSync: (agentId) => {
      const instance = kernel.instances.getSync(makeAgentID(agentId))
      return instance !== undefined ? toInstanceView(instance) : undefined
    },
    getChildren: (agentId) => kernel.lineage.getChildren(makeAgentID(agentId)),
    getAncestors: (agentId) => kernel.lineage.getAncestors(makeAgentID(agentId)),
    getDescendants: (agentId) => kernel.lineage.getDescendants(makeAgentID(agentId)),
    getAgentConfig: (agentId) => {
      const node = kernel.lineage.nodeConfigOf(agentId)
      if (node === undefined) return undefined
      return {
        ...(node.model !== undefined ? { model: node.model } : {}),
        ...(node.access !== undefined ? { access: toAccessView(node.access) } : {}),
      }
    },
  }

  const context: ContextPort = {
    registerPause: (agentId, opts) => kernel.contextManager.registerPause(agentId, opts),
    getState: async (agentId) => {
      const state = await kernel.contextManager.getState(agentId)
      return { messages: state.messages.map((m) => ({ id: m.id, turn: m.turn, role: m.message.role })) }
    },
    runStrategyAction: (agentId, action, args) => kernel.contextManager.runStrategyAction(agentId, action, args),
    markInvalid: (agentId, ids) => kernel.repository.markInvalid(agentId, ids),
    updateMessageContent: async (agentId, messageId, content) => {
      const state = await kernel.contextManager.getState(agentId)
      const stored = state.messages.find((m) => m.id === messageId)
      if (stored === undefined) throw { kind: 'message_not_found', messageId }
      await kernel.repository.updateMessage(agentId, messageId, { ...stored.message, content })
    },
    exportJsonl: (agentId) => kernel.contextManager.exportJsonl(agentId),
    overview: (agentId) => kernel.contextManager.overview(agentId),
  }

  const telemetry: TelemetryPort = {
    allLogs: () => kernel.logger.all(),
  }

  const access: AccessPort = {
    reply: (input, agentId) => kernel.access.reply(input, agentId),
  }

  return { agents, context, telemetry, access }
}
