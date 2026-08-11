// ============================================================
// core/kernel/AgentKernel.ts —— Kernel 组合容器（core 内部组合根）
//
// 组装 registry / instances / spaces / runtime，提供便捷入口：
//   - getOrCreateAgent：Scheduler 最小直通（Task 1.2）
//   - run：agent.run 通路
// 宿主（shell / 未来 adapters）只需注入 gateway + defaultModel。
// ============================================================

import type { ModelGateway } from '../gateway'
import type { LLMEvent, ModelRef, UsageEvent } from '../gateway'
import simpleChatTemplate from '../../../templates/SimpleChat.json'
import coderTemplate from '../../../templates/Coder.json'
import { DefaultAgentTemplateRegistry } from './AgentTemplateRegistry'
import type { AgentTemplateRegistry } from './AgentTemplateRegistry'
import { DefaultAgentInstanceManager } from './AgentInstanceManager'
import type { AgentInstanceManager, InstantiateOptions } from './AgentInstanceManager'
import { DefaultAgentSpaceManager } from './AgentSpaceManager'
import type { AgentSpaceManager } from './AgentSpaceManager'
import { DefaultAgentRuntime } from './AgentRuntime'
import type { AgentRuntime, ChatResult, RuntimeRunOptions } from './AgentRuntime'
import type { AgentClass, AgentClassID, AgentID, AgentSpaceID, ProjectRef } from './types'

/** 内置示例模板（从 templates/*.json 加载，非硬编码角色）。 */
export const BUILTIN_TEMPLATES: readonly AgentClass[] = [
  simpleChatTemplate as unknown as AgentClass,
  coderTemplate as unknown as AgentClass,
]

export interface AgentKernelOptions {
  readonly gateway: ModelGateway
  /** 模板未配置 model 时的默认模型。 */
  readonly defaultModel: ModelRef
  /** 覆盖内置模板（缺省用 templates/*.json）。 */
  readonly templates?: readonly AgentClass[]
  readonly maxSteps?: number
  readonly estimateCost?: (usage: UsageEvent | undefined) => number
}

export class AgentKernel {
  readonly templates: AgentTemplateRegistry
  readonly instances: AgentInstanceManager
  readonly spaces: AgentSpaceManager
  readonly runtime: AgentRuntime

  constructor(options: AgentKernelOptions) {
    this.templates = new DefaultAgentTemplateRegistry(options.templates ?? BUILTIN_TEMPLATES)
    this.instances = new DefaultAgentInstanceManager(this.templates)
    this.spaces = new DefaultAgentSpaceManager()
    this.runtime = new DefaultAgentRuntime({
      gateway: options.gateway,
      instances: this.instances,
      templates: this.templates,
      defaultModel: options.defaultModel,
      maxSteps: options.maxSteps,
      estimateCost: options.estimateCost,
    })
  }

  /** Scheduler 最小直通：空间内已存在该类的实例则复用，否则创建。 */
  async getOrCreateAgent(
    classId: AgentClassID,
    project: ProjectRef,
    opts?: Omit<InstantiateOptions, 'spaceId'>,
  ): Promise<AgentID> {
    const space = await this.spaces.getOrCreate(project)
    const existing = await this.instances.listBySpace(space.id)
    const found = existing.find((agent) => agent.classRef === classId)
    if (found) return found.id
    const instance = await this.instances.instantiate(classId, { spaceId: space.id, ...opts })
    return instance.id
  }

  /** 对话通路：kernel → scheduler → agent.run。 */
  async run(agentId: AgentID, input: string, opts?: RuntimeRunOptions): Promise<ChatResult> {
    return this.runtime.run(agentId, input, opts)
  }

  /** 空间内实例列表。 */
  async listAgentsBySpace(spaceId: AgentSpaceID): Promise<AgentID[]> {
    const agents = await this.instances.listBySpace(spaceId)
    return agents.map((agent) => agent.id)
  }
}
