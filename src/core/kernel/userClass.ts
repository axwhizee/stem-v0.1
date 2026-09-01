// ============================================================
// core/kernel/userClass.ts —— 内置 user 类（系统根模板）
//
// user0 = user 类的普通实例（parentId=null 即根），无任何特判。
// 类配置 = config.user 对象（元 agent 单独处理为对象，完整可配）；
// tools 给出则**整表替换**内置默认表（键即白名单，user0 生效权限
// 由台账注册期物化）。缺省走 DEFAULT_USER_TOOLS：
//   - access_reply 必须显式 allow——根答复义务，缺失 = ask 消息化死锁；
//   - 管理/观察/上下文面显式声明（internal 工具默认隐藏，模板显式赋权）；
//   - 高危面（建类/销毁）ask；未列出的键对 user0 一律 deny（本地封闭），
//     但"缺席 ≠ 否决"——不锁子孙的显式申请（锁止请用显式 deny，铁律）。
// ============================================================

import type { ModelRef } from '../gateway'
import type { ToolAccess } from '../tools'
import type { AgentClass } from './types'
import { makeAgentClassID } from './types'

/** user 类 id（内置根模板；user0 采用此类实例化）。 */
export const USER_CLASS_ID = makeAgentClassID('user')

/** user 类配置（与 config.StemUserClass 同构，model 已解析为 ModelRef；init 层映射注入）。 */
export interface UserClassConfig {
  readonly description?: string
  readonly systemPrompt?: string
  /** = user 类 tools 清单（给出则整表替换默认）。 */
  readonly tools?: Readonly<Record<string, ToolAccess>>
  readonly contextStrategy?: string
  readonly model?: ModelRef
  readonly sendCountdown?: number
}

/** 内置 user 类默认工具清单（config.user.tools 缺省时生效）。 */
export const DEFAULT_USER_TOOLS: Readonly<Record<string, ToolAccess>> = {
  // 根答复义务（ask 消息化的授权侧）——绝不可缺，缺失 = 权限系统死锁。
  access_reply: 'allow',
  // 对外操作面：bash = 最小系统唯一外部操作入口（internal 显式 allow——
  // 高频工具不走 ask，治理靠超时/截断机制与提示词分担，见 tools/bash）。
  bash: 'allow',
  // 管理面：user0 经工具驱动系统（pilot 旁路之外的模型侧能力）。
  agent_instantiate: 'allow',
  agent_list: 'allow',
  agent_inspect: 'allow',
  agent_ancestry: 'allow',
  agent_descendants: 'allow',
  agent_class_list: 'allow',
  bus_send: 'allow',
  bus_participants: 'allow',
  // 上下文面：查看/整理自身与子孙上下文。
  context_overview: 'allow',
  context_export: 'allow',
  context_remove: 'allow',
  context_edit: 'allow',
  context_apply: 'allow',
  // 高危面：始终经根确认（user0 的 ask 发给自己，由 shell 弹窗/CLI 确认）。
  agent_class_create: 'ask',
  agent_terminate: 'ask',
}

/** 构造内置 user 类：全字段消费 config.user（人格声明式可配）。 */
export function createUserClass(cfg?: UserClassConfig): AgentClass {
  return {
    name: USER_CLASS_ID,
    description:
      cfg?.description ??
      'user 类：系统根 agent（元 agent），由人类经 pilot 扮演；tools = config.user.tools（缺省内置管理面）。',
    systemPrompt: cfg?.systemPrompt ?? '',
    tools: cfg?.tools ?? DEFAULT_USER_TOOLS,
    sendCountdown: cfg?.sendCountdown ?? 0,
    ...(cfg?.contextStrategy !== undefined ? { contextStrategy: cfg.contextStrategy } : {}),
    ...(cfg?.model !== undefined ? { model: cfg.model } : {}),
  }
}
