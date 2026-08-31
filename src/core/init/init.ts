// ============================================================
// core/init/init.ts —— 初始化管线（config 同步 + 注册到 core）
//
// 流程（纯 TS，fs/import 经 InitDeps 注入）：
//   1. 读取唯一配置（ConfigStore.load）；
//   2. 扫描 `tool/`、`agent/` 目录；
//   3. 同步注册表到 stem.jsonc（纯镜像）：
//        - 发现的工具/agent → 登记（同名 id）；
//        - 已注册但无实现文件 → 移除（orphan_registration issue）；
//   4. 注册到 core：
//        - 用户工具 → ToolCapabilityRegistry（kind 强制 'user'）；
//        - 用户 agent → TemplateRegistry（解析 YAML 头 + 正文）。
//   5. 写回配置（仅当注册表变化时）。
// ============================================================

import { applyEdits, modify } from 'jsonc-parser'
import type { RegisteredAgent, RegisteredStrategy, RegisteredTool, StemConfig } from '../config'
import { parseConfigText } from '../config'
import type { AgentClass, AgentClassID } from '../kernel'
import { makeAgentClassID } from '../kernel'
import type { ContextStrategyModule } from '../context'
import type { ToolCapability } from '../tools'
import { parseAgentFile } from './agentParse'
import type { InitDeps, InitError, InitIssue, InitReport } from './types'

const DEFAULT_CONFIG_TEXT = `{
  // stem 唯一配置文件：全局配置 + 同步注册表（tools/agents/strategies 由 init 自动维护）。
  "model": "opencode-go/deepseek-v4-flash",
  "autoApprove": false,
  // user0 内嵌 agent 类（元 agent 完整可配；permission 缺省 = 内置管理面默认表）。
  "user": {},
  // 上下文策略（classic compact 参数面）。
  "context": { "window": 128000, "compact": { "enabled": true, "threshold": 0.8, "keepRecentTurns": 3 } },
  "sendCountdown": 1000
}
`

/** 运行初始化管线。 */
export async function runInit(deps: InitDeps): Promise<InitReport> {
  const { config } = deps
  const loaded = await config.store.load()
  const current: StemConfig = loaded.config

  // 扫描目录。
  const toolFiles = await safeList(deps, config.paths.toolDir)
  const agentFiles = await safeList(deps, config.paths.agentDir)
  const strategyFiles = await safeList(deps, config.paths.strategyDir)

  // 逐文件解析/加载。
  const issues: InitIssue[] = []
  const tools = await loadUserTools(deps, toolFiles, issues)
  const agents = await loadUserAgents(deps, agentFiles, issues)
  const strategies = await loadUserStrategies(deps, strategyFiles, issues)

  // 同步注册表（纯镜像）：新工具/agent/策略 → 登记；已注册但无实现 → 移除。
  const syncedTools: RegisteredTool[] = tools.map((tool) => ({ id: tool.id, file: relOf(config.paths.toolDir, tool.file), kind: 'user', enabled: true }))
  const syncedAgents: RegisteredAgent[] = agents.map((agent) => ({ id: agent.name, file: relOf(config.paths.agentDir, agent.file) }))
  const syncedStrategies: RegisteredStrategy[] = strategies.map((strategy) => ({ id: strategy.module.name, file: relOf(config.paths.strategyDir, strategy.file) }))
  collectOrphans(current.tools ?? [], syncedTools, 'tool', issues)
  collectOrphans(current.agents ?? [], syncedAgents, 'agent', issues)
  collectOrphans(current.strategies ?? [], syncedStrategies, 'strategy', issues)

  // 注册到 core。
  const registeredTools = await registerTools(deps, tools, issues)
  const registeredAgents = await registerAgents(deps, agents, issues)
  registerStrategies(deps, strategies, issues)

  // 写回配置（仅当注册表变化，且首次创建时总是写）。
  const changed = loaded.raw === undefined || !sameRegistry(current, syncedTools, syncedAgents, syncedStrategies)
  if (changed) {
    const text = syncConfigText(loaded.raw, syncedTools, syncedAgents, syncedStrategies)
    await config.store.save(text)
  }

  return {
    config: { ...current, tools: syncedTools, agents: syncedAgents, strategies: syncedStrategies },
    tools: syncedTools,
    agents: syncedAgents,
    registeredTools,
    registeredAgents,
    issues,
  }
}

/** 扫描工具文件（.ts/.tsx，默认导出 ToolCapability）。 */
async function loadUserTools(deps: InitDeps, files: readonly string[], issues: InitIssue[]): Promise<Array<ToolCapability & { file: string }>> {
  const result: Array<ToolCapability & { file: string }> = []
  for (const file of files) {
    if (!/\.tsx?$/.test(file)) continue
    let mod: { readonly default?: unknown }
    try {
      mod = await deps.tools.loadTool(file)
    } catch (cause) {
      issues.push({ kind: 'tool_load_failed', file, message: cause instanceof Error ? cause.message : String(cause) })
      continue
    }
    const tool = mod.default
    if (tool === undefined || tool === null || typeof tool !== 'object') {
      issues.push({ kind: 'tool_invalid', file, message: '工具文件必须默认导出一个 ToolCapability 对象' })
      continue
    }
    const t = tool as Partial<ToolCapability>
    if (typeof t.id !== 'string' || typeof t.description !== 'string' || typeof t.execute !== 'function') {
      issues.push({ kind: 'tool_invalid', file, message: '缺少 id / description / execute' })
      continue
    }
    result.push({ ...(t as ToolCapability), kind: 'user', file })
  }
  return result
}

/** 扫描 agent 文件（.md，YAML 头 + 正文）。 */
async function loadUserAgents(deps: InitDeps, files: readonly string[], issues: InitIssue[]): Promise<Array<AgentClass & { file: string }>> {
  const result: Array<AgentClass & { file: string }> = []
  for (const file of files) {
    if (!/\.md$/.test(file)) continue
    const text = await safeRead(deps, file, issues)
    if (text === undefined) continue
    // 文件名即 agent 类 id/name（实例化时才命名）。
    const filename = basename(file).replace(/\.md$/, '')
    try {
      const parsed = parseAgentFile(text, filename)
      const cls: AgentClass = {
        name: makeAgentClassID(parsed.name),
        description: parsed.description,
        systemPrompt: parsed.systemPrompt,
        // 融合：工具清单 = permission 的键 → 动作（键即白名单）。
        tools: parsed.toolAccess,
        ...(parsed.sendCountdown !== undefined ? { sendCountdown: parsed.sendCountdown } : {}),
        ...(parsed.contextStrategy !== undefined ? { contextStrategy: parsed.contextStrategy } : {}),
        ...(parsed.model !== undefined ? { model: parsed.model } : {}),
        ...(Object.keys(parsed.custom).length > 0 ? { custom: parsed.custom } : {}),
      }
      result.push({ ...cls, file })
    } catch (cause) {
      issues.push({ kind: 'agent_parse_failed', file, message: cause instanceof Error ? cause.message : String(cause) })
    }
  }
  return result
}

/**
 * 扫描用户上下文策略（`.stem/context/*.ts`，默认导出 ContextStrategyModule）。
 * "让 agent 自己写策略"的加载通道（与 .stem/tool 同构，自我进化承载之一）。
 */
async function loadUserStrategies(
  deps: InitDeps,
  files: readonly string[],
  issues: InitIssue[],
): Promise<Array<{ module: ContextStrategyModule; file: string }>> {
  const result: Array<{ module: ContextStrategyModule; file: string }> = []
  for (const file of files) {
    if (!/\.tsx?$/.test(file)) continue
    let mod: { readonly default?: unknown }
    try {
      mod = await deps.tools.loadTool(file)
    } catch (cause) {
      issues.push({ kind: 'strategy_load_failed', file, message: cause instanceof Error ? cause.message : String(cause) })
      continue
    }
    const candidate = mod.default as Partial<ContextStrategyModule> | undefined
    if (
      candidate === undefined ||
      candidate === null ||
      typeof candidate !== 'object' ||
      typeof candidate.name !== 'string' ||
      typeof candidate.assemble !== 'function'
    ) {
      issues.push({ kind: 'strategy_invalid', file, message: '策略文件必须默认导出 ContextStrategyModule（含 name + assemble）' })
      continue
    }
    result.push({ module: candidate as ContextStrategyModule, file })
  }
  return result
}

/** 注册用户策略（覆盖内置 = 用户主权；issue 不中断）。 */
function registerStrategies(
  deps: InitDeps,
  strategies: readonly { module: ContextStrategyModule; file: string }[],
  issues: InitIssue[],
): void {
  const registry = deps.strategyRegistry
  if (!registry) return
  for (const { module, file } of strategies) {
    try {
      registry.register(module)
    } catch (cause) {
      issues.push({ kind: 'strategy_invalid', file, message: cause instanceof Error ? cause.message : String(cause) })
    }
  }
}

/** 注册用户工具（冲突/非法 → issue，不中断）。 */
async function registerTools(deps: InitDeps, tools: readonly (ToolCapability & { file: string })[], issues: InitIssue[]): Promise<ToolCapability[]> {
  const registered: ToolCapability[] = []
  for (const tool of tools) {
    try {
      await deps.toolRegistry.register({ ...tool, kind: 'user' })
      registered.push(tool)
      deps.onLog?.log({
        type: 'init.tool.registered',
        at: Date.now(),
        tool: tool.id,
        file: tool.file,
      })
    } catch (cause) {
      issues.push({ kind: 'tool_invalid', file: tool.file, message: cause instanceof Error ? cause.message : String(cause) })
    }
  }
  return registered
}

/** 注册用户 agent 类（冲突/非法 → issue，不中断）。 */
async function registerAgents(deps: InitDeps, agents: readonly (AgentClass & { file: string })[], issues: InitIssue[]): Promise<AgentClass[]> {
  const registered: AgentClass[] = []
  for (const agent of agents) {
    try {
      await deps.templateRegistry.register(agent)
      registered.push(agent)
      deps.onLog?.log({
        type: 'init.agent.registered',
        at: Date.now(),
        classId: agent.name as unknown as string,
        file: agent.file,
      })
    } catch (cause) {
      issues.push({ kind: 'agent_invalid', file: agent.file, message: cause instanceof Error ? cause.message : String(cause) })
    }
  }
  return registered
}

/** 检查"已注册但无实现文件"（纯镜像：登记里存在但镜像里没有 → 孤儿）。 */
function collectOrphans(
  registered: readonly (RegisteredTool | RegisteredAgent | RegisteredStrategy)[],
  mirror: readonly { id: string }[],
  type: 'tool' | 'agent' | 'strategy',
  issues: InitIssue[],
): void {
  const mirrorIds = new Set(mirror.map((m) => m.id))
  for (const entry of registered) {
    if (!mirrorIds.has(entry.id)) {
      issues.push({ kind: 'orphan_registration', type, id: entry.id, file: entry.file })
    }
  }
}

/** 比较注册表是否变化。 */
function sameRegistry(
  current: StemConfig,
  tools: readonly RegisteredTool[],
  agents: readonly RegisteredAgent[],
  strategies: readonly RegisteredStrategy[],
): boolean {
  return (
    JSON.stringify(current.tools ?? []) === JSON.stringify(tools) &&
    JSON.stringify(current.agents ?? []) === JSON.stringify(agents) &&
    JSON.stringify(current.strategies ?? []) === JSON.stringify(strategies)
  )
}

/** 用 jsonc-parser 同步注册表字段（保留注释与其它配置项）。 */
function syncConfigText(
  raw: string | undefined,
  tools: readonly RegisteredTool[],
  agents: readonly RegisteredAgent[],
  strategies: readonly RegisteredStrategy[],
): string {
  const base = raw ?? DEFAULT_CONFIG_TEXT
  let text = base
  text = applyEdits(text, modify(text, ['tools'], tools, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
  text = applyEdits(text, modify(text, ['agents'], agents, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
  text = applyEdits(text, modify(text, ['strategies'], strategies, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
  return text
}

// ---------- 小工具 ----------

async function safeList(deps: InitDeps, dir: string): Promise<readonly string[]> {
  try {
    return await deps.fs.listFiles(dir)
  } catch {
    return []
  }
}

async function safeRead(deps: InitDeps, file: string, issues: InitIssue[]): Promise<string | undefined> {
  try {
    return await deps.fs.readText(file)
  } catch (cause) {
    issues.push({ kind: 'agent_parse_failed', file, message: `读取失败：${cause instanceof Error ? cause.message : String(cause)}` })
    return undefined
  }
}

function basename(file: string): string {
  const idx = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return idx >= 0 ? file.slice(idx + 1) : file
}

function relOf(base: string, file: string): string {
  const idx = file.indexOf(base)
  if (idx < 0) return file
  const rel = file.slice(idx + base.length)
  return rel.replace(/^[/\\]+/, '')
}

function initError(e: InitError): InitError {
  return e
}

export { initError, parseConfigText }
