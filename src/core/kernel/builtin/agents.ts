// ============================================================
// core/kernel/builtin/agents.ts —— 内置 agent 类唯一定义域（S9 类形态统一）
//
// 全体类通道（.stem/agent/*.md、config.user、策略 spec、agent_class_*）
// 同产 AgentClass 一个形状；内置静态类在此一张表——**新增类参数只改
// AgentClass 接口，本表自动够着**（旧 Assistant.json 单独文件 +
// userClass.ts 单独域双轨制退役，手写映射漂移源根除）。
// 策略自带类（CLASSIC_ROLE/SUMMARIZER/CORTEX_ROLE/DREAM_WORKER）**不在
// 此表**——"策略自带人设"（决策 C），生命周期随策略模块；形状已统一。
//
// user0 = user 类的普通实例（parentId=null 即根），无任何特判。
// 类配置 = config.user 对象（完整可配）。**DEFAULT_USER_TOOLS 代码兜底表已
// 退役**（出生声明+收敛链模型）：config.user.tools 给出即为根收敛清单（键
// 即白名单，逐键被注册表出生值封顶——越界 = boot 硬错）；缺省 = 完整继承
// 出生表面（全系统无缺省注入）。首启模板实值（推荐清单）住在
// config/defaults.ts 的 DEFAULT_CONFIG_TEXT——模板不是机制，只是一份写好的
// config；boot 校验律保证 access_reply 生效 allow，缺位拒启。
// ============================================================

import type { ModelRef } from '../../gateway'
import type { ToolAccess } from '../../tools'
import type { AgentClass } from '../types'
import { makeAgentClassID, USER_CLASS_ID } from '../types'

/** user 类配置（与 config.StemUserClass 同构，model 已解析为 ModelRef；init 层映射注入）。 */
export interface UserClassConfig {
  readonly description?: string
  readonly systemPrompt?: string
  /** = user 类 tools 收敛清单（键即白名单、逐键出生封顶；缺省 = 完整继承出生表）。 */
  readonly tools?: Readonly<Record<string, ToolAccess>>
  readonly contextStrategy?: string
  readonly model?: ModelRef
  readonly sendCountdown?: number
  /** user0 出生显示名（S9；实例参数不上类——缺省 'User'，运行期可经 agent_update 改）。 */
  readonly displayName?: string
}

/** user 类默认档（config.user 缺位时的全字段值；tools 不设 = 完整继承出生表）。 */
export const USER_DEFAULT: AgentClass = {
  name: USER_CLASS_ID,
  description:
    'user 类：系统根 agent，由人类经 pilot 扮演；tools = config.user.tools 收敛清单（缺省 = 完整继承出生表；access_reply 生效 allow 由 boot 校验律保证）。',
  systemPrompt: '',
  sendCountdown: 0,
}

/** 通用助手（internal 占位类）：无类层限定——工具清单未设 = 完整继承父
 *  档案，模型走四级解析链，是最小可用的对话承载。 */
export const ASSISTANT: AgentClass = {
  name: makeAgentClassID('assistant'),
  description:
    '通用助手（internal 占位类）：无类层限定——工具清单未设 = 完整继承父档案，模型走四级解析链，是最小可用的对话承载',
  systemPrompt: 'You are a helpful assistant.',
}

/** 内置类全表（文档/测试遍历用；Kernel 装配 = buildUserClass(cfg) + BUILTIN_TEMPLATES）。 */
export const BUILTIN_AGENT_CLASSES: readonly AgentClass[] = [USER_DEFAULT, ASSISTANT]

/** user 类装配 = 默认档全字段消费 config.user（人格声明式可配）。 */
export function buildUserClass(cfg?: UserClassConfig): AgentClass {
  return {
    ...USER_DEFAULT,
    ...(cfg?.description !== undefined ? { description: cfg.description } : {}),
    ...(cfg?.systemPrompt !== undefined ? { systemPrompt: cfg.systemPrompt } : {}),
    ...(cfg?.tools !== undefined ? { tools: cfg.tools } : {}),
    ...(cfg?.sendCountdown !== undefined ? { sendCountdown: cfg.sendCountdown } : {}),
    ...(cfg?.contextStrategy !== undefined ? { contextStrategy: cfg.contextStrategy } : {}),
    ...(cfg?.model !== undefined ? { model: cfg.model } : {}),
  }
}
