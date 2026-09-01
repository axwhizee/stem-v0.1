// ============================================================
// core/init/init.ts —— 初始化管线（扫描目录 + 注册到 core）
//
// 流程（纯 TS，fs/import 经 InitDeps 注入）：
//   1. 读取唯一配置（ConfigStore.load）；
//   2. 扫描 `tools/`、`agent/`、`context/` 目录（**目录即真相**，S4.2）；
//   3. 注册到 core：
//        - 用户工具 → ToolCapabilityRegistry（kind 强制 'user'）；
//        - 用户 agent → TemplateRegistry（解析 YAML 头 + 正文）；
//        - 用户策略 → StrategyRegistry（同名覆盖内置 = 用户主权）。
//   4. 仅当配置文件不存在时写入初始模板（不做任何回写同步）。
// ============================================================

import type { AgentClass, AgentClassID } from '../kernel'
import { makeAgentClassID } from '../kernel'
import type { ContextStrategyModule } from '../context'
import type { ToolCapability } from '../tools'
import { DEFAULT_CONFIG_TEXT } from '../config'
import { parseAgentFile } from './agentParse'
import type { InitDeps, InitError, InitIssue, InitReport } from './types'

/** 运行初始化管线。 */
export async function runInit(deps: InitDeps): Promise<InitReport> {
  const { config } = deps
  const loaded = await config.store.load()

  // 扫描目录（目录即真相）。
  const toolFiles = await safeList(deps, config.paths.toolDir)
  const agentFiles = await safeList(deps, config.paths.agentDir)
  const strategyFiles = await safeList(deps, config.paths.strategyDir)

  // 逐文件解析/加载。
  const issues: InitIssue[] = []
  const tools = await loadUserTools(deps, toolFiles, issues)
  const agents = await loadUserAgents(deps, agentFiles, issues)
  const strategies = await loadUserStrategies(deps, strategyFiles, issues)

  // 注册到 core。
  const registeredTools = await registerTools(deps, tools, issues)
  const registeredAgents = await registerAgents(deps, agents, issues)
  registerStrategies(deps, strategies, issues)

  // 首次创建时写入初始模板（此后永不回写——config 是用户的，管线只读）。
  if (loaded.raw === undefined) {
    await config.store.save(DEFAULT_CONFIG_TEXT)
  }

  return {
    tools: tools.map((tool) => ({ id: tool.id, file: relOf(config.paths.toolDir, tool.file) })),
    agents: agents.map((agent) => ({ id: agent.name as AgentClassID as string, file: relOf(config.paths.agentDir, agent.file) })),
    strategies: strategies.map((strategy) => ({ id: strategy.module.name, file: relOf(config.paths.strategyDir, strategy.file) })),
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
 * "让 agent 自己写策略"的加载通道（与 .stem/tools 同构，自我进化承载之一）。
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

export { initError }
