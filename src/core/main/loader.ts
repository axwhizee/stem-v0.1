// ============================================================
// core/main/loader.ts —— 资源装载管线（装载面二元制：工具点名、类/策略目录扫描）
//
// 流程（纯 TS，fs/import 经 InitDeps 注入）：
//   1. 读取唯一配置（ConfigStore.load）；
//   2. 工具 = **config.extensions.tools {名: 权限词} 点名**（装载与出生一句话）：
//        名字先探 extension/tools/<名>/<名>.ts，再探 .stem/tools/<名>.ts 与
//        <名>/<名>.ts——**解析不到 = 抛错拒启**（boot 校验律：config 键必须有
//        装载源兑现）。custom 目录自动扫描已废止（未点名 = 不存在于世界）。
//      agent 类 / context 策略 = `.stem/` 目录即真相自动扫描（用户主权书写面），
//        extension 层按 config.extensions.agent/context 点名。
//      装载律 internal → extension → custom，后层同名覆盖前层（replace）。
//   3. 注册到 core：工具 → ToolCapabilityRegistry（kind = 纯 provenance，
//      birth = config 权限词）；agent 类 → TemplateRegistry；策略 → StrategyRegistry。
//   4. 仅当配置文件不存在时写入初始模板（不做任何回写同步）。
// ============================================================

import type { AgentClass, AgentClassID } from '../kernel'
import { makeAgentClassID, pickAgentClassGenes } from '../kernel'
import type { ContextStrategyModule } from '../context'
import type { ToolAccess, ToolCapability } from '../tools'
import { DEFAULT_CONFIG_TEXT, parseAgentFile } from '../config'
import type { DiscoveredEntry, InitDeps, InitError, InitIssue, InitReport, ResourceEntry } from './types'

/** 运行初始化管线。 */
export async function runInit(deps: InitDeps): Promise<InitReport> {
  const { config } = deps
  const loaded = await config.store.load()

  const ext = loaded.config.extensions ?? {}
  const roots = deps.extensionRoots ?? {}
  const issues: InitIssue[] = []

  // 工具点名装载（extension 源 → custom 源双解析；不可解析 = 抛错拒启）；
  // agent/策略 = extension 点名 + .stem/ 目录扫描。
  const tools = await loadNamedTools(deps, roots.tools, ext.tools ?? {}, issues)
  const extAgents = await loadExtensionAgents(deps, roots.agent, ext.agent ?? [], issues)
  const cusAgents = await loadCustomAgents(deps, config.paths.agentDir, issues)
  const extStrategies = await loadExtensionStrategies(deps, roots.context, ext.context ?? [], issues)
  const cusStrategies = await loadCustomStrategies(deps, config.paths.strategyDir, issues)
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
    tools: tools.map((t) => entry(t.id, t.file, t.kind === 'extension' ? 'extension' : 'custom', config)),
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

/**
 * 点名工具装载（A1）：config.extensions.tools 的 {名: 权限词} 逐个解析——
 * extension 源优先（`extension/tools/<名>/<名>.ts`），custom 源兜底
 * （`.stem/tools/<名>.ts` 或 `<名>/<名>.ts`）。装载与出生一句话说完
 * （kind = provenance 层、birth = config 权限词，文件自述值被覆盖）。
 * 任一名字解析不到 = 抛错（boot 校验律——config 键必须有装载源兑现）。
 */
async function loadNamedTools(
  deps: InitDeps,
  root: string | undefined,
  named: Readonly<Record<string, import('../tools').ToolAccess>>,
  issues: InitIssue[],
): Promise<Array<ToolCapability & { file: string }>> {
  const result: Array<ToolCapability & { file: string }> = []
  // 入口允许工厂形态：default = ToolCapability | (projectRoot) => ToolCapability
  //（工作区级工具需要空间根做路径沙箱——extension 目录在仓库、服务对象是空间）。
  const materialize = async (def0: unknown, file: string): Promise<ToolCapability | undefined> => {
    let def = def0
    if (typeof def === 'function') {
      def = await (def as (projectRoot: string) => ToolCapability | Promise<ToolCapability>)(
        deps.config.paths.projectRoot,
      )
    }
    return validateTool(def, file, issues)
  }
  for (const [name, birth] of Object.entries(named)) {
    // ① extension 源（目录形态唯一）。
    if (root !== undefined) {
      const file = `${root}/${name}/${name}.ts`
      try {
        const mod = await deps.tools.loadTool(file)
        const tool = await materialize(mod.default, file)
        if (tool) {
          result.push({ ...tool, kind: 'extension', birth, file })
          continue
        }
      } catch {
        /* extension 源未命中 → 落 custom 源探测 */
      }
    }
    // ② custom 源（空间点名 = 唯一入世界通道；平铺与目录两形）。
    const dir = deps.config.paths.toolDir
    const candidates = [`${dir}/${name}/${name}.ts`, `${dir}/${name}.ts`]
    let hit: string | undefined
    for (const cand of candidates) {
      if ((await deps.fs.readText(cand).catch(() => undefined)) !== undefined) {
        hit = cand
        break
      }
    }
    if (hit === undefined) {
      throw initError({
        kind: 'tool_unresolvable',
        file: `${dir}/（点名源）`,
        message: `config.extensions.tools 点名的工具 "${name}" 解析不到装载源（extension/tools/ 与 .stem/tools/ 均无 ${name}）——未点名/无名可出的代码不存在于世界，键不可解析 = 拒启`,
      })
    }
    let mod: { readonly default?: unknown }
    try {
      mod = await deps.tools.loadTool(hit)
    } catch (cause) {
      throw initError({
        kind: 'tool_unresolvable',
        file: hit,
        message: `点名工具 "${name}" 装载失败（文件存在但模块加载出错）：${cause instanceof Error ? cause.message : String(cause)}`,
      })
    }
    const tool = await materialize(mod.default, hit)
    if (tool) result.push({ ...tool, kind: 'custom', birth, file: hit })
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

// ---------- custom 层（agent/策略目录扫描；工具改点名制见 loadNamedTools） ----------

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
      tools: parsed.toolAccess,
      ...pickAgentClassGenes({
        ...(parsed.sendCountdown !== undefined ? { sendCountdown: parsed.sendCountdown } : {}),
        ...(parsed.contextStrategy !== undefined ? { contextStrategy: parsed.contextStrategy } : {}),
        ...(parsed.model !== undefined ? { model: parsed.model } : {}),
      }),
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
