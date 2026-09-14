// ============================================================
// core/main/systemFacade.ts —— SystemFacade 适配器（组合根实现）
//
// pilot 消费 SystemFacade 接口（kernel 声明）；本文件把 Kernel 的域操作
// 适配为门面方法，组合根注入 createPilot。方向：main → kernel（单向）。
// ============================================================

import type { SystemFacade } from '../kernel'
import { makeAgentID } from '../kernel'
import type { Kernel } from '../kernel'

/** 由 Kernel 构造 SystemFacade（pilot 扮演面）。 */
export function createSystemFacade(kernel: Kernel): SystemFacade {
  return {
    subscribe: (listener) => kernel.events.subscribe(listener),
    appendHistory: (agentId, message) => kernel.contextManager.appendHistory(agentId, message),
    sendUserMessage: (agentId, text) => kernel.sendUserMessage(agentId, text),
    instantiate: (opts) => kernel.instantiateInSpace(opts),
    setAgentModel: (agentId, model, opts) => kernel.setAgentModel(agentId, model, opts),
    terminateAgent: (agentId, opts) => kernel.terminateAgent(agentId, opts),
    interruptAgent: (agentId, opts) => kernel.interruptAgent(agentId, opts),
    replyAccess: (input, by) => kernel.access.reply(input, by),

    listInstances: () => kernel.instances.listAll(),
    getInstance: (agentId) => kernel.instances.get(agentId),
    getInstanceSync: (agentId) => kernel.instances.getSync(makeAgentID(agentId)),

    activeAgents: () => kernel.activeAgents(),
    contextOverview: (agentId) => kernel.contextOverview(agentId),
    exportContext: (agentId) => kernel.exportContext(agentId),
    runStrategyAction: (agentId, action, args) => kernel.contextManager.runStrategyAction(agentId, action, args),

    registerRootAgent: () => kernel.registerRootAgent(),
    alignRootName: () => kernel.alignRootName(),
  }
}
