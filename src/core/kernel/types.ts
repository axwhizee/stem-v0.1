// ============================================================
// core/kernel/types.ts —— Agent Kernel 领域类型（纯 TS，零平台依赖）
//
// branded id / AgentClass（模板）/ AgentInstance（实例）/
// AgentSpace / 错误判别联合。
// ============================================================

import type { ModelRef } from '../gateway'
import type { ToolAccess } from '../tools'

// ---------- branded id ----------

declare const agentClassId: unique symbol
export type AgentClassID = string & { readonly [agentClassId]: 'AgentClassID' }

declare const agentId: unique symbol
export type AgentID = string & { readonly [agentId]: 'AgentID' }

/** 项目/工作区引用（本阶段用字符串路径；单空间——不再有多 space 实体）。 */
export type ProjectRef = string

/** user 类 id（内置根模板；根实例采用此类。name 即 id 的类表世界）。 */
export const USER_CLASS_ID = makeAgentClassID('user')

/**
 * 根 id = 出生路径的起点（B1：id 是纯推导的族谱地址，系统全托管）：
 * 根 = `0`；子 = `<父id>-<出生序号>`（序号 1 起、永不回收，terminate 留墓碑）。
 * 代际 = 段数、父 = 去尾段、祖先链 = 前缀——零查询纯字符串推导。
 */
export const ROOT_ID = makeAgentID('0')

/** 根的缺省 name（全名呈现 `user#0`；config.user.name 可给实值）。 */
export const ROOT_NAME = 'user'

/** 出生路径 id 的合法形：数字段以 `-` 连接（`0`、`0-3`、`0-3-2-7`）。 */
export const AGENT_ID_PATTERN = /^\d+(-\d+)*$/

/** 路径父解析：`0-3-2` → `0-3`；根 `0` → null（纯推导，不查树）。 */
export function parentIdOf(agentId: AgentID): AgentID | null {
  const cut = agentId.lastIndexOf('-')
  return cut < 0 ? null : (agentId.slice(0, cut) as AgentID)
}

/** 全名呈现（信件戳/列表/审批卡/错误 message 统一 `name#id`）。 */
export function formatFull(name: string, agentId: AgentID | string): string {
  return `${name}#${agentId}`
}

export function makeAgentClassID(id: string): AgentClassID {
  return id as AgentClassID
}

export function makeAgentID(id: string): AgentID {
  return id as AgentID
}

// ---------- 状态 ----------

/**
 * 实例状态机：
 *   idle →(邮局送信)→ thinking(请求已发) →(LLM 返回)→ holding(等待下一次送信)；
 *   interrupted：当前轮被中断（用户/进程/网络/工具错误），实例仍存活、消息完整，下一次送信自动恢复；
 *   terminated：归档墓碑——个体已销毁后**地址与名字的占用记录**（序号永不回收，
 *   历史信件指错实体绝对禁止）。只在持久层在场，永不进活体面（list/get/族谱皆不可见）。
 */
export type AgentStatus = 'idle' | 'thinking' | 'holding' | 'interrupted' | 'terminated'

// ---------- AgentClass（模板，用户主权的载体） ----------

/**
 * AgentClass（模板）。**name 即 id**（注册时查重），无单独 id 字段。
 * 工具清单 `tools` 融合白名单与访问：`Record<访问键, ask|deny|allow|ignore>`，
 * **键即白名单**（未列出的工具不可用），值对全局表做收敛补充（只能更严格）。
 * `contextStrategy` 为实例上下文管理策略（默认 classic），在开辟上下文空间时写入。
 */
export interface AgentClass {
  /** 类名，唯一（注册时查重；即模板键）。 */
  readonly name: AgentClassID
  readonly description: string
  /**
   * 该类实例可用的工具清单（融合白名单+访问）：Record<访问键, ask|deny|allow|ignore>。
   * 空 Record = 本地封闭（无工具）；**未设 = 完整继承父生效档案**（族谱台账律，
   * internal 占位类 assistant 即此形）。
   */
  readonly tools?: Readonly<Record<string, ToolAccess>>
  /** 该类的专属系统提示词（模板承载，实例化注册到邮局）。 */
  readonly systemPrompt: string
  /** 上下文管理策略（默认 classic；实例化时写入上下文属性）。 */
  readonly contextStrategy?: string
  /** 可选模型偏好。 */
  readonly model?: ModelRef
  /** 送信倒计时（毫秒，默认 1000）；实例化时传给邮局。 */
  readonly sendCountdown?: number
  /**
   * true = 模块扮演面板（不组装、不跑 LLM 轮，信件由扮演模块消费）——
   * 策略 role（context 模块扮演）经此字段声明。**面板性双入径**：根实例
   * （user#0，parentId=null）不经此字段，由 kernel 根接线 `assemble:false`
   * 获得同一形态（pilot 扮演）——面板性皆结构性事实，非类特权。
   */
  readonly panel?: boolean
  /** 用户自定义元数据。 */
  readonly custom?: Readonly<Record<string, unknown>>
  /**
   * 单轮工具步数上限（S9；资源上限非权限——不进族谱律，不继承不封顶）。
   * 解析 = 类基因 > 全局 config.maxSteps > 缺省无限；≤0/未设 = 无限制。
   */
  readonly maxSteps?: number
}

// ---------- 模型解析相（S6/R6 四级律；lineage 树与实例行共用形状） ----------

/** 模型解析命中层（agent_inspect 谱系出示）。 */
export type ModelOrigin =
  /** 实例行显式值（agent_instantiate model 参 / set_model 改写）。 */
  | 'explicit'
  /** 所属类的基因（AgentClass.model；非根类）。 */
  | 'class'
  /** 父档案继承而来（父的生效模型下传）。 */
  | 'inherited'
  /** 家学 = 根（user#0）的类模型（config.user.model，全链锚点）。 */
  | 'home'

/** 模型绑定 = 生效模型 + 解析命中层（git-blame 语义）。 */
export interface ModelBinding {
  readonly ref: ModelRef
  readonly origin: ModelOrigin
}

// ---------- AgentInstance（运行时原子单位） ----------

/**
 * AgentInstance（运行时原子单位）。**自包含**：模型生效绑定随行持久，
 * 重启不需类模板即可恢复运行模型（类仍负责 systemPrompt/策略/工具基因）。
 * **id = 出生路径**（B1 系统全托管：根 `0`，子 `<父id>-<序号>`；不可变、不复用）。
 * **parentId 即 creatorId 合并**：谁创建实例，谁就是族谱父（根为 null 即根）。
 */
export interface AgentInstance {
  readonly id: AgentID
  /** 模板名（即模板键）。 */
  readonly classRef: AgentClassID
  /** 族谱父（= 创建者；根为 null）；创建时确定、不可变，且是 id 的前缀真相。 */
  readonly parentId: AgentID | null
  /**
   * **全局唯一称呼**（B2）：出生 = 显式指定（撞名拒）或确定性推导 `类名-N`；
   * 运行期可经 agent_update.name 改（撞名拒）；呈现面统一 `name#id`。
   */
  name: string
  status: AgentStatus
  turnCount: number
  totalCost: number
  /** **终身累计 token**（每轮 usage in+out 累加；不受 compact 压缩影响——
   *  与 ctxTokens（当前上下文占用）两本账。旧行缺字段 = restore 归零）。 */
  totalTokens: number
  /**
   * **反馈式上下文占用**：最近一次请求 API 返回的 `prompt_tokens`，初始 0/缺省。
   * cortex 水位等策略判据用；与 totalTokens 终身账分开。
   */
  ctxTokens?: number
  /** 实例化时必填的 user prompt（作为首封信投递，符合 openai messages 规范）。 */
  readonly userPrompt: string
  /** 实例化时传入的工具清单补充（对模板表的收敛，可临时收紧；运行时仅用于组装）。 */
  readonly toolOverride?: Readonly<Record<string, ToolAccess>>
  /**
   * **模型显式层**：agent_instantiate 显式指定或 agent_update 运行改写
   * 的落盘载体。缺省 = 无显式值，解析链上溯类基因/父继承/家学。
   */
  readonly model?: ModelRef
  /**
   * **出生解析落地**（实例化一次性求解：显式 > 类基因 > 父继承 > 家学）：
   * 生效模型 + origin 随行持久，重启不需类模板恢复运行模型。
   * 「改父不动子」由本字段天然保证——改的是节点自身显式层，子女绑定已落地。
   * 出生后必有；旧库缺字段 = restore 期按 model/类基因回填。
   */
  readonly modelBinding?: ModelBinding
}

/** 用户接管/微调可更新的字段。 */
/** 实例参数更新补丁（kernel.updateAgent 的合法可写面——类定义/父子拓扑/
 *  策略/systemPrompt/userPrompt 永不在内：族谱与类文件事实不走此通道）。 */
export interface AgentInstancePatch {
  name?: string
  toolOverride?: Readonly<Record<string, ToolAccess>>
  model?: ModelRef
}

// ---------- 错误（判别联合，code-style §4.1） ----------

export type KernelError =
  | { readonly kind: 'template_not_found'; readonly classId: AgentClassID }
  | { readonly kind: 'invalid_template'; readonly classId: AgentClassID; readonly message: string }
  | { readonly kind: 'template_exists'; readonly classId: AgentClassID }
  | { readonly kind: 'agent_not_found'; readonly agentId: AgentID }
  /** 寻址歧义（唯一前缀律被破：多活体共享前缀；candidates = name#id 列表）。 */
  | { readonly kind: 'agent_ref_ambiguous'; readonly ref: string; readonly candidates: readonly string[] }
  | { readonly kind: 'agent_conflict'; readonly message: string }
  /** 称呼冲突（全局唯一执法面含墓碑；出生撞名/改名撞名/装载撞名三级共用）。 */
  | { readonly kind: 'agent_name_conflict'; readonly name: string; readonly message: string }
  /** 族谱解析链无模型锚（正常不发生：boot 硬校验 config.user.model；恢复残卷防御）。 */
  | { readonly kind: 'model_unresolved'; readonly agentId: AgentID }
