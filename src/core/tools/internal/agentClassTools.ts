// ============================================================
// core/tools/internal/agentClassTools.ts —— agent 类书写面工具
//
// 注册即注册声明；消费方拥有端口（./ports），零 kernel import。
// ============================================================

import type { ToolCapability, ToolAccess } from '../types'
import type { EffortLevel, ModelRef } from '../../gateway'
import { parseModelRef } from '../../gateway'
import type { SystemToolHost } from './ports'
import { checkToolsConvergence } from '../access'
import { MODEL_FORMAT_HINT, resolveOr } from './shared'

/** 创建新 agent 类（admin 权限，D7/铁律 8）。只承载类属性，不含实例数据（userPrompt 等）。 */
export function agentClassCreate(host: SystemToolHost): ToolCapability {
  return {
    id: 'agent_class_create',
    description:
      '创建新的 agent 类（模板）并回写 `.stem/agent/<name>.md`（目录即真相，重启后仍生效——进化书写面）。新名 = 变体并存（供谱系对照与回滚）；同名会被拒绝（覆盖现役请用 agent_class_update）。类定义角色设定（systemPrompt / tools 工具清单 / contextStrategy / model / sendCountdown / temperature / effort），不包含任何实例化数据（如 userPrompt）；实例化请用 agent_instantiate。tools 为工具访问键到访问动作的映射（键即白名单，未列出的工具不可用；对继承面只能收敛）。',
    accessKey: 'agent_class_create',
    registerAccess: 'ignore', // 注册声明（agent_class_create）
    kind: 'internal',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '类名（唯一，即类 id，kebab-case）' },
        description: { type: 'string', description: '类用途描述' },
        systemPrompt: { type: 'string', description: '该类的专属系统提示词' },
        tools: { type: 'object', description: '工具清单：访问键 → allow|ask|deny|ignore（键即白名单，对继承面收敛）' },
        contextStrategy: { type: 'string', description: '上下文管理策略（默认 classic）' },
        model: { type: 'string', description: '模型（"提供商/模型"，可选；缺省沿 类基因>父继承 解析）' },
        sendCountdown: { type: 'number', description: '送信倒计时毫秒（可选，缺省 1000）' },
        temperature: { type: 'number', description: '采样温度（可选）' },
        effort: { type: 'string', description: '思考强度 none/low/medium/high（可选，缺省 none）' },
      },
      required: ['name', 'description'],
    },
    execute: async (input, ctx) => {
      const args = input as {
        name: string
        description: string
        systemPrompt?: string
        tools?: Readonly<Record<string, ToolAccess>>
        contextStrategy?: string
        model?: string
        sendCountdown?: number
        temperature?: number
        effort?: EffortLevel
      }
      let model: ModelRef | undefined
      if (args.model !== undefined) {
        const parsed = parseModelRef(args.model)
        if (parsed === undefined) return { text: MODEL_FORMAT_HINT }
        model = parsed
      }
      const cls = {
        name: args.name,
        description: args.description,
        systemPrompt: args.systemPrompt ?? '',
        tools: args.tools ?? {},
        ...(args.contextStrategy !== undefined ? { contextStrategy: args.contextStrategy } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(args.sendCountdown !== undefined ? { sendCountdown: args.sendCountdown } : {}),
        ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
        ...(args.effort !== undefined ? { effort: args.effort } : {}),
      }
      await host.agents.registerAgentClass(cls, { persist: true, by: ctx.agentId })
      return {
        text: `已创建 agent 类 ${args.name}（tools=${Object.keys(cls.tools).length} 条规则，${host.agents.hasClassStore() ? '已落盘 .stem/agent/，重启后仍生效' : '仅内存注册——宿主未启用类回写通道'}）`,
      }
    },
  }
}

/**
 * 更新现役 agent 类（S5.2 进化书写面：同名覆盖 + 落盘，方案 §4.2）。
 * 边界（设计内）：①只影响**后续实例**（已绑定能力物化于族谱树，防"改类即远程改现役"）；
 * ②工具路径**只许收敛**（本层同尺预检换 agent 文案；硬门禁在 kernel.updateAgentClass）；
 * ③系统机制类与 user 根类不可改（红线：系统机制与用户基因分界；根人格归 config.user）。
 */
export function agentClassUpdate(host: SystemToolHost): ToolCapability {
  return {
    id: 'agent_class_update',
    description:
      '更新现役 agent 类并回写 `.stem/agent/<name>.md`（同名覆盖；进化书写面）。缺省目标 = 你所属的类（显式 name 可指向其它类，经 ask 授权）。tools 只能收敛（deny 不可撤销，ask 不得升为 allow/ignore）；systemPrompt/description/model/contextStrategy/sendCountdown 可改。**只影响后续实例**（你的既有权限面不变）。',
    accessKey: 'agent_class_update',
    registerAccess: 'ignore', // 注册声明（agent_class_update）
    kind: 'internal',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '目标类名（缺省 = 调用者所属类）' },
        description: { type: 'string', description: '新类描述' },
        systemPrompt: { type: 'string', description: '新系统提示词' },
        tools: { type: 'object', description: '工具清单增量更新（未提及键保留原值；提及键逐键只能收敛，不可扩张）' },
        contextStrategy: { type: 'string', description: '上下文策略名' },
        model: { type: 'string', description: '模型（"提供商/模型"）' },
        sendCountdown: { type: 'number', description: '送信倒计时毫秒' },
        temperature: { type: 'number', description: '采样温度' },
        effort: { type: 'string', description: '思考强度 none/low/medium/high' },
      },
    },
    execute: async (input, ctx) => {
      const args = input as {
        name?: string
        description?: string
        systemPrompt?: string
        tools?: Readonly<Record<string, ToolAccess>>
        contextStrategy?: string
        model?: string
        sendCountdown?: number
        temperature?: number
        effort?: EffortLevel
      }
      // 缺省目标 = 调用者所属类（自我进化主路径）。
      const selfClass = host.agents.getInstanceSync(ctx.agentId)?.classRef
      const target = args.name !== undefined ? args.name : selfClass
      if (target === undefined) return { text: '无法确定目标类（请显式给出 name）' }
      if (target === 'user') {
        return { text: 'user 根类的基因由 config.user（stem.jsonc）承载，不经本通道改写' }
      }
      const current = host.agents.getClassSync(target)
      if (!current) return { text: `类不存在: ${target}（新建请用 agent_class_create）` }
      if (args.tools !== undefined) {
        const violations = checkToolsConvergence(current.tools, args.tools)
        if (violations.length > 0) {
          return { text: `工具清单只能收敛，以下违规：\n${violations.map((v) => `  - ${v}`).join('\n')}` }
        }
      }
      // tools patch = 增量合并（未提及键保留原值——整表替换会静默丢键，属意外收缩陷阱）。
      const mergedTools = args.tools !== undefined ? { ...current.tools, ...args.tools } : undefined
      let model: ModelRef | undefined
      if (args.model !== undefined) {
        const parsed = parseModelRef(args.model)
        if (parsed === undefined) return { text: MODEL_FORMAT_HINT }
        model = parsed
      }
      const patch = {
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.systemPrompt !== undefined ? { systemPrompt: args.systemPrompt } : {}),
        ...(args.contextStrategy !== undefined ? { contextStrategy: args.contextStrategy } : {}),
        ...(args.sendCountdown !== undefined ? { sendCountdown: args.sendCountdown } : {}),
        ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
        ...(args.effort !== undefined ? { effort: args.effort } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(mergedTools !== undefined ? { tools: mergedTools } : {}),
      }
      const patchKeys = Object.keys(patch)
      if (patchKeys.length === 0) return { text: '无可更新字段（description/systemPrompt/tools/model/contextStrategy/sendCountdown 至少给一项）' }
      const { persisted } = await host.agents.updateAgentClass(target, patch, { persist: true, by: ctx.agentId })
      return {
        text: `已更新类 ${target}（${patchKeys.join(', ')}；${persisted ? '已落盘 .stem/agent/' : '仅内存更新——宿主未启用类回写通道'}；对后续实例生效）`,
      }
    },
  }
}

export function agentClassList(host: SystemToolHost): ToolCapability {
  return {
    id: 'agent_class_list',
    description: '列出全部 agent 类（模板）及关键属性。',
    accessKey: 'agent_class_list',
    registerAccess: 'ignore', // 注册声明（agent_class_list）
    kind: 'internal',
    category: 'system',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const classes = await host.agents.listClasses()
      const lines = classes.map(
        (c) =>
          `${c.name}  tools=${c.tools === undefined ? 'inherit' : Object.keys(c.tools).length > 0 ? Object.entries(c.tools).map(([t, a]) => `${t}:${a}`).join(',') : '-'}${c.contextStrategy ? `  strategy=${c.contextStrategy}` : ''}${c.model ? `  model=${c.model.id}` : ''}`,
      )
      return { text: lines.length > 0 ? `agent 类列表:\n${lines.join('\n')}` : '（暂无 agent 类）' }
    },
  }
}

/** 创建 agent 实例（必填 className + userPrompt；父 = 调用者）。 */
