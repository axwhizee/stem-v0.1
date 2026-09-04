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
// 类配置 = config.user 对象（完整可配）；tools 给出则**整表替换**内置
// 默认表（键即白名单，user0 生效权限由台账注册期物化）。缺省
// DEFAULT_USER_TOOLS：
//   - access_reply 必须显式 allow——根答复义务，缺失 = ask 消息化死锁；
//   - 管理/观察/上下文面显式声明（internal 工具默认隐藏，模板显式赋权）；
//   - 高危面（建类/销毁）ask；未列出的键对 user0 一律 deny（本地封闭），
//     但"缺席 ≠ 否决"——不锁子孙的显式申请（锁止请用显式 deny，铁律）。
// ============================================================

import type { ModelRef } from '../../gateway'
import type { ToolAccess } from '../../tools'
import type { AgentClass } from '../types'
import { makeAgentClassID, USER_CLASS_ID } from '../types'

/** user 类配置（与 config.StemUserClass 同构，model 已解析为 ModelRef；init 层映射注入）。 */
export interface UserClassConfig {
  readonly description?: string
  readonly systemPrompt?: string
  /** = user 类 tools 清单（给出则整表替换默认）。 */
  readonly tools?: Readonly<Record<string, ToolAccess>>
  readonly contextStrategy?: string
  readonly model?: ModelRef
  readonly sendCountdown?: number
  /** user0 出生显示名（S9；实例参数不上类——缺省 'User'，运行期可经 agent_update 改）。 */
  readonly displayName?: string
}

/** 内置 user 类默认工具清单（config.user.tools 缺省时生效）。 */
export const DEFAULT_USER_TOOLS: Readonly<Record<string, ToolAccess>> = {
  // 根答复义务（ask 消息化的授权侧）——绝不可缺，缺失 = 权限系统死锁。
  access_reply: 'allow',
  // 对外操作面：bash = 最小系统唯一外部操作入口（internal 显式 allow——
  // 高频工具不走 ask，治理靠超时/截断机制与提示词分担，见 tools/bash）。
  bash: 'allow',
  // 对外信息面（extension 点名安装后生效；与 bash 同权级：无 ask，
  // 未安装 = 键空转无副作用）。
  websearch: 'allow',
  webfetch: 'allow',
  // 管理面：user0 经工具驱动系统（pilot 旁路之外的模型侧能力）。
  agent_instantiate: 'allow',
  agent_list: 'allow',
  agent_inspect: 'allow',
  agent_ancestry: 'allow',
  agent_descendants: 'allow',
  agent_class_list: 'allow',
  // 运行时模型面（S6/R7）：根经本表自改/代查改后代（可见域 = 根天然全视；
  // 家学锚点本体 config.user.model 只可经配置文件改，工具面改的是实例显式层）。
  agent_update: 'ask',
  bus_send: 'allow',
  bus_participants: 'allow',
  // 观察面：运行日志查询（telemetry；纯查询无副作用，可见域=树位置函数）。
  telemetry_query: 'allow',
  // skill 兼容装载器（S7 零系统 skill 机制：约定 id 的 custom 工具
  // `.stem/tools/skill/skill.ts`；空间未安装 = 键空转无副作用）。
  skill: 'allow',
  // 上下文面：查看/整理自身与子孙上下文。
  context_overview: 'allow',
  context_export: 'allow',
  context_remove: 'allow',
  context_edit: 'allow',
  context_apply: 'allow',
  // 记忆笔记面（S8/cortex）：add/del_note 常开（继承形全树白拿；非 cortex
  // 类 agent 也可用——目录按 caller 建，值在挂 cortex 策略的类才兑现）。
  // set_ltm/set_stm **不列** = 全树匿名 deny——记忆固化是 dream worker
  // （受限 grant 表显式放行）专属事务，agent 本体碰不到。
  cortex_add_note: 'allow',
  cortex_del_note: 'allow',
  // 高危面：始终经根确认（user0 的 ask 发给自己，由 shell 弹窗/CLI 确认）。
  // 类书写面（S5.2 进化）：创建/更新均落盘 `.stem/agent/`，根批准才生效。
  agent_class_create: 'ask',
  agent_class_update: 'ask',
  agent_terminate: 'ask',
}

/** user 类默认档（config.user 缺位时的全字段值；displayName 走实例通道不在此）。 */
export const USER_DEFAULT: AgentClass = {
  name: USER_CLASS_ID,
  description:
    'user 类：系统根 agent（元 agent），由人类经 pilot 扮演；tools = config.user.tools（缺省内置管理面）。',
  systemPrompt: '',
  tools: DEFAULT_USER_TOOLS,
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
