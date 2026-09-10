// ============================================================
// core/kernel/systemFacade.ts —— 系统门面（pilot 消费面；D4 门面化）
//
// pilot（根扮演接口）只依赖本接口，不依赖具体 Kernel；实现由组合根
// （main/systemFacade.ts）从 Kernel 适配注入。pilot 与 Kernel 由此解耦，
// 便于测试替代与未来多身份扮演。
// ============================================================

import type { ChatMessage, ModelRef } from '../gateway'
import type { AccessReplyInput } from '../tools'
import type { PilotEvent } from '../events'
import type { InstantiateOptions } from './InstanceManager'
import type { AgentID, AgentInstance, AgentSpace, AgentSpaceID, ProjectRef } from './types'

export interface SystemFacade {
  /** 订阅统一事件流（PilotEvent：stream/letter/status/notice）。 */
  readonly subscribe: (listener: (event: PilotEvent) => void) => () => void
  /** 追加某 agent 的历史消息（根扮演：把人类输出记为根的 assistant 行）。 */
  readonly appendHistory: (agentId: string, message: ChatMessage) => Promise<void>
  /** 以根身份向目标 agent 发消息。 */
  readonly sendUserMessage: (agentId: string, text: string) => Promise<void>
  /** 取或建空间（返回空间 id）。 */
  readonly getOrCreateSpace: (project: ProjectRef) => Promise<AgentSpaceID>
  /** 指定空间实例化（parentId 等由 opts 承载）。 */
  readonly instantiate: (opts: Omit<InstantiateOptions, 'spaceId'>, spaceId: AgentSpaceID | string) => Promise<AgentID>
  /** 运行期换模型（可见域由调用层负责；by 记审计）。 */
  readonly setAgentModel: (agentId: string, model: ModelRef, opts?: { readonly by?: string }) => Promise<void>
  /** 终止 agent。 */
  readonly terminateAgent: (agentId: string, opts?: { readonly by?: string; readonly recursive?: boolean }) => Promise<void>
  /** 中断 agent 当前轮。 */
  readonly interruptAgent: (agentId: string, opts?: { readonly by?: string }) => Promise<void>
  /** 回复访问申请（by 缺省根）。 */
  readonly replyAccess: (input: AccessReplyInput, by: string) => Promise<void>

  readonly listInstancesInSpace: (spaceId: string) => Promise<readonly AgentInstance[]>
  readonly listSpaces: () => Promise<readonly AgentSpace[]>
  readonly getInstance: (agentId: AgentID) => Promise<AgentInstance>
  readonly getInstanceSync: (agentId: string) => AgentInstance | undefined

  readonly activeAgents: () => readonly AgentID[]
  readonly contextOverview: (agentId: string) => Promise<string>
  readonly exportContext: (agentId: string) => Promise<string>
  readonly runStrategyAction: (agentId: string, action: string, args?: string) => Promise<string>

  /** 根初始化：注册（首启）或对齐称呼（重启）。 */
  readonly registerRootAgent: () => Promise<AgentID>
  readonly alignRootName: () => Promise<void>
}
