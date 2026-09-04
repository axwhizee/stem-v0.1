// ============================================================
// core/init/init.ts —— 初始化管线（三维资源矩阵统一装载，S7）
//
// 流程（纯 TS，fs/import 经 InitDeps 注入）：
//   1. 读取唯一配置（ConfigStore.load）；
//   2. 三类资源（tools / agent 类 / context 策略）× 两来源层统一装载：
//        extension 层 = `extension/<种类>/<名>/<名>.<ext>` 目录形态，
//          按 config.extensions.<种类> 点名启用（tools 缺省 = fs 五件套）；
//        custom 层 = `.stem/` 自动扫描（**目录即真相**）：平铺单文件兼容，
//          目录形态 `<名>/<名>.<ext>` 优先（同名后装载者胜）。
//      装载律 internal → extension → custom，后层同名覆盖前层（replace）。
//   3. 注册到 core：工具 → ToolCapabilityRegistry（kind 注 extension/custom）；
//      agent 类 → TemplateRegistry；策略 → StrategyRegistry（覆盖内置 = 用户主权）。
//   4. 仅当配置文件不存在时写入初始模板（不做任何回写同步）。
// ============================================================

import type { AgentClass, AgentClassID } from '../kernel'
import { makeAgentClassID } from '../kernel'
import type { ContextStrategyModule } from '../context'
import type { ToolCapability } from '../tools'
import { DEFAULT_CONFIG_TEXT } from '../config'
import { parseAgentFile } from './agentParse'
import type { DiscoveredEntry, InitDeps, InitError, InitIssue, InitReport, ResourceEntry } from './types'

/** extension tools 层缺省清单（config.extensions.tools 键缺失时；S7/D9）。 */
export const DEFAULT_EXTENSION_TOOLS: readonly string[] = ['read', 'write', 'edit', 'grep', 'glob']

/** 运行初始化管线。 */
export async function runInit(deps: InitDeps): Promise<InitReport> {
  const { config } = deps
  const loaded = await config.store.load()

  const ext = loaded.config.extensions ?? {}
  const roots = deps.extensionRoots ?? {}
  const issues: InitIssue[] = []

  // 逐种类装载：extension 层（点名）→ custom 层（目录即真相）。
  const extTools = await loadExtensionTools(deps, roots.tools, ext.tools ?? DEFAULT_EXTENSION_TOOLS, issues)
  const cusTools = await loadCustomTools(deps, config.paths.toolDir, issues)
  const extAgents = await loadExtensionAgents(deps, roots.agent, ext.agent ?? [], issues)
  const cusAgents = await loadCustomAgents(deps, config.paths.agentDir, issues)
  const extStrategies = await loadExtensionStrategies(deps, roots.context, ext.context ?? [], issues)
  const cusStrategies = await loadCustomStrategies(deps, config.paths.strategyDir, issues)
  const tools = [...extTools, ...cusTools]
  const agents = [...extAgents, ...cusAgents]
  const strategies = [...extStrategies, ...cusStrategies]

  // 注册到 core（后层同名覆盖前层 = 装载律；issue 不中断）。
  const registeredTools = await registerTools(deps, tools, issues)
  const registeredAgents = await registerAgents(deps, agents, issues)
  registerStrategies(deps, strategies, issues)

  // 首次创建时写入初始模板（此后永不回写——config 是用户的，管线只读）。
  if (loaded.raw === undefined) {
    await config.store.save(DEFAULT_CONFIG_TEXT)
  }

  return {
    tools: [
      ...extTools.map((t) => entry(t.id, t.file, 'extension', config)),
      ...cusTools.map((t) => entry(t.id, t.file, 'custom', config)),
    ],
    agents: [
      ...extAgents.map((a) => entry(a.name as AgentClassID as string, a.file, 'extension', config)),
      ...cusAgents.map((a) => entry(a.name as AgentClassID as string, a.file, 'custom', config)),
    ],
    strategies: [
      ...extStrategies.map((s) => entry(s.module.name, s.file, 'extension', config)),
      ...cusStrategies.map((s) => entry(s.module.name, s.file, 'custom', config)),
    ],
    registeredTools,
    registeredAgents,
    issues,
  }
}

// ---------- extension 层（点名启用，目录形态唯一） ----------

/** 装载单个 extension 条目：加载器成功返回默认导出，缺失/坏件记 issue。 */
async function loadExtensionEntry(
  deps: InitDeps,
  root: string,
  name: string,
  ext: 'ts' | 'md',
  issues: InitIssue[],
): Promise<ResourceEntry | undefined> {
  const file = `${root}/${name}/${name}.${ext}`
  if (ext === 'ts') {
    try {
      const mod = await deps.tools.loadTool(file)
      if (mod.default === undefined || mod.default === null) {
        issues.push({ kind: 'extension_entry_missing', file, message: `extension 条目 ${name} 无默认导出` })
        return undefined
      }
      return { name, file, module: mod.default }
    } catch (cause) {
      issues.push({
        kind: 'extension_entry_missing',
        file,
        message: `config.extensions 点名的 extension 条目 ${name} 装载失败：${cause instanceof Error ? cause.message : String(cause)}（extension 资源必须为目录形态 <名>/<名>.ts）`,
      })
      return undefined
    }
  }
  const text = await deps.fs.readText(file).catch(() => undefined)
  if (text === undefined) {
    issues.push({ kind: 'extension_entry_missing', file, message: `config.extensions 点名的 extension 类 ${name} 不存在（应为 <名>/<名>.md）` })
    return undefined
  }
  return { name, file, module: text }
}

async function loadExtensionTools(
  deps: InitDeps,
  root: string | undefined,
  names: readonly string[],
  issues: InitIssue[],
): Promise<Array<ToolCapability & { file: string }>> {
  const result: Array<ToolCapability & { file: string }> = []
  if (root === undefined) return result // 宿主未提供 extension 根 = 本层整体不存在（如精简内嵌）。
  for (const name of names) {
    const entry = await loadExtensionEntry(deps, root, name, 'ts', issues)
    if (entry === undefined) continue
    // extension 工具入口允许工厂形态：default = ToolCapability | (projectRoot) => ToolCapability
    //（工作区级工具需要空间根做路径沙箱——extension 目录在仓库、服务对象是空间）。
    let def = entry.module
    if (typeof def === 'function') {
      def = await (def as (projectRoot: string) => ToolCapability | Promise<ToolCapability>)(
        deps.config.paths.projectRoot,
      )
    }
    const tool = validateTool(def, entry.file, issues)
    if (tool) result.push({ ...tool, kind: 'extension', file: entry.file })
  }
  return result
}

async function loadExtensionAgents(
  deps: InitDeps,
  root: string | undefined,
  names: readonly string[],
  issues: InitIssue[],
): Promise<Array<AgentClass & { file: string }>> {
  const result: Array<AgentClass & { file: string }> = []
  if (root === undefined) return result
  for (const name of names) {
    const entry = await loadExtensionEntry(deps, root, name, 'md', issues)
    if (entry) parseAgentInto(entry.module as string, entry.name, entry.file, result, issues)
  }
  return result
}

async function loadExtensionStrategies(
  deps: InitDeps,
  root: string | undefined,
  names: readonly string[],
  issues: InitIssue[],
): Promise<Array<{ module: ContextStrategyModule; file: string }>> {
  const result: Array<{ module: ContextStrategyModule; file: string }> = []
  if (root === undefined) return result
  for (const name of names) {
    const entry = await loadExtensionEntry(deps, root, name, 'ts', issues)
    const strategy = validateStrategy(entry?.module, entry?.file ?? name, issues)
    if (strategy) result.push({ module: strategy, file: entry!.file })
  }
  return result
}

// ---------- custom 层（目录即真相：平铺 + 目录形态，目录优先） ----------

async function loadCustomTools(
  deps: InitDeps,
  dir: string,
  issues: InitIssue[],
): Promise<Array<ToolCapability & { file: string }>> {
  const result: Array<ToolCapability & { file: string }> = []
  for (const { name, file } of await discoverFiles(deps, dir, 'ts')) {
    let mod: { readonly default?: unknown }
    try {
      mod = await deps.tools.loadTool(file)
    } catch (cause) {
      issues.push({ kind: 'tool_load_failed', file, message: cause instanceof Error ? cause.message : String(cause) })
      continue
    }
    const tool = validateTool(mod.default, file, issues)
    if (tool) result.push({ ...tool, kind: 'custom', file })
    void name
  }
  return result
}

async function loadCustomAgents(
  deps: InitDeps,
  dir: string,
  issues: InitIssue[],
): Promise<Array<AgentClass & { file: string }>> {
  const result: Array<AgentClass & { file: string }> = []
  for (const { name, file } of await discoverFiles(deps, dir, 'md')) {
    const text = await safeRead(deps, file, issues)
    if (text !== undefined) parseAgentInto(text, name, file, result, issues)
  }
  return result
}

async function loadCustomStrategies(
  deps: InitDeps,
  dir: string,
  issues: InitIssue[],
): Promise<Array<{ module: ContextStrategyModule; file: string }>> {
  const result: Array<{ module: ContextStrategyModule; file: string }> = []
  for (const { file } of await discoverFiles(deps, dir, 'ts')) {
    let mod: { readonly default?: unknown }
    try {
      mod = await deps.tools.loadTool(file)
    } catch (cause) {
      issues.push({ kind: 'strategy_load_failed', file, message: cause instanceof Error ? cause.message : String(cause) })
      continue
    }
    const strategy = validateStrategy(mod.default, file, issues)
    if (strategy) result.push({ module: strategy, file })
  }
  return result
}

/**
 * custom 目录资源发现：平铺文件（按后缀）在前、目录形态在后
 * （`<名>/<名>.<ext>`，`_` 前缀目录 = 非资源跳过；同名时目录经 replace 优先）。
 */
async function discoverFiles(
  deps: InitDeps,
  dir: string,
  ext: 'ts' | 'md',
): Promise<Array<{ name: string; file: string }>> {
  const pattern = ext === 'ts' ? /\.tsx?$/ : /\.md$/
  const flat = (await safeList(deps, dir))
    .filter((f) => pattern.test(f))
    .map((f) => ({ name: basename(f).replace(/\.tsx?|\.md$/, ''), file: f }))
  const packed: Array<{ name: string; file: string }> = []
  for (const sub of await safeListDirs(deps, dir)) {
    const name = basename(sub)
    if (name.startsWith('_') || name.startsWith('.')) continue
    const entryFile = `${sub}/${name}.${ext}`
    // 入口文件存在才算资源包（探测失败 = 普通子目录，静默跳过）。
    if ((await deps.fs.readText(entryFile).catch(() => undefined)) !== undefined) {
      packed.push({ name, file: entryFile })
    }
  }
  return [...flat, ...packed]
}

// ---------- 形状校验/注册 ----------

function validateTool(candidate: unknown, file: string, issues: InitIssue[]): ToolCapability | undefined {
  if (candidate === undefined || candidate === null || typeof candidate !== 'object') {
    issues.push({ kind: 'tool_invalid', file, message: '工具文件必须默认导出一个 ToolCapability 对象' })
    return undefined
  }
  const t = candidate as Partial<ToolCapability>
  if (typeof t.id !== 'string' || typeof t.description !== 'string' || typeof t.execute !== 'function') {
    issues.push({ kind: 'tool_invalid', file, message: '缺少 id / description / execute' })
    return undefined
  }
  return t as ToolCapability
}

function validateStrategy(candidate: unknown, file: string, issues: InitIssue[]): ContextStrategyModule | undefined {
  const c = candidate as Partial<ContextStrategyModule> | null | undefined
  if (c === undefined || c === null || typeof c !== 'object' || typeof c.name !== 'string' || typeof c.assemble !== 'function') {
    issues.push({ kind: 'strategy_invalid', file, message: '策略文件必须默认导出 ContextStrategyModule（含 name + assemble）' })
    return undefined
  }
  return c as ContextStrategyModule
}

function parseAgentInto(
  text: string,
  filename: string,
  file: string,
  result: Array<AgentClass & { file: string }>,
  issues: InitIssue[],
): void {
  try {
    const parsed = parseAgentFile(text, filename)
    const cls: AgentClass = {
      name: makeAgentClassID(parsed.name),
      description: parsed.description,
      systemPrompt: parsed.systemPrompt,
      // 融合：工具清单 = permission 的键 → 动作（键即白名单）。
      tools: parsed.toolAccess,
      ...(parsed.sendCountdown !== undefined ? { sendCountdown: parsed.sendCountdown } : {}),
      ...(parsed.maxSteps !== undefined ? { maxSteps: parsed.maxSteps } : {}),
      ...(parsed.contextStrategy !== undefined ? { contextStrategy: parsed.contextStrategy } : {}),
      ...(parsed.model !== undefined ? { model: parsed.model } : {}),
      ...(Object.keys(parsed.custom).length > 0 ? { custom: parsed.custom } : {}),
    }
    result.push({ ...cls, file })
  } catch (cause) {
    issues.push({ kind: 'agent_parse_failed', file, message: cause instanceof Error ? cause.message : String(cause) })
  }
}

/** 注册工具（冲突 → issue 不中断；replace = 矩阵装载律）。 */
async function registerTools(
  deps: InitDeps,
  tools: readonly (ToolCapability & { file: string })[],
  issues: InitIssue[],
): Promise<ToolCapability[]> {
  const registered: ToolCapability[] = []
  for (const tool of tools) {
    try {
      await deps.toolRegistry.register(tool, { replace: true })
      registered.push(tool)
      deps.onLog?.log({ type: 'init.tool.registered', at: Date.now(), tool: tool.id, file: tool.file })
    } catch (cause) {
      issues.push({ kind: 'tool_invalid', file: tool.file, message: cause instanceof Error ? cause.message : String(cause) })
    }
  }
  return registered
}

/** 注册 agent 类（冲突 → issue 不中断；replace = 矩阵装载律）。 */
async function registerAgents(
  deps: InitDeps,
  agents: readonly (AgentClass & { file: string })[],
  issues: InitIssue[],
): Promise<AgentClass[]> {
  const registered: AgentClass[] = []
  for (const agent of agents) {
    try {
      await deps.templateRegistry.register(agent, { replace: true })
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

// ---------- 小工具 ----------

async function safeList(deps: InitDeps, dir: string): Promise<readonly string[]> {
  try {
    return await deps.fs.listFiles(dir)
  } catch {
    return []
  }
}

async function safeListDirs(deps: InitDeps, dir: string): Promise<readonly string[]> {
  try {
    return await deps.fs.listDirs(dir)
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

/** 报告条目（file 相对其所属资源根展示 + 标注来源层）。 */
function entry(id: string, file: string, layer: 'extension' | 'custom', config: InitDeps['config']): DiscoveredEntry {
  const base = config.paths
  const rel = fileOf(file, base.toolDir, base.agentDir, base.strategyDir)
  return { id, file: rel, layer }
}

function fileOf(file: string, ...bases: string[]): string {
  for (const b of bases) {
    const idx = file.indexOf(b)
    if (idx >= 0) return file.slice(idx + b.length).replace(/^[/\\]+/, '')
  }
  return file
}

function initError(e: InitError): InitError {
  return e
}

export { initError }
