// ============================================================
// core/main/loader.test.ts —— 资源装载管线单测（装载面二元制：工具点名、类/策略扫描，内存 fake）
// ============================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConfigLoadResult, ConfigPaths, ConfigStore } from '../config'
import { parseConfigText } from '../config'
import type { AgentClass, AgentClassID } from '../kernel'
import { makeAgentClassID } from '../kernel'
import type { ToolCapability } from '../tools'
import { DefaultToolCapabilityRegistry } from '../tools'
import { DefaultStrategyRegistry } from '../context'
import { DefaultTemplateRegistry } from '../kernel'
import { runInit } from './loader'
import type { InitDeps, InitFs, InitReport } from './types'

/** 模拟 drain：发现清单 → register(replace)（发现段不注册工具）。 */
async function drainInventory(deps: InitDeps, report: InitReport): Promise<void> {
  for (const t of report.toolInventory) await deps.toolRegistry.register(t, { replace: true })
}

function makePaths(toolDir = '/proj/.stem/tools', agentDir = '/proj/.stem/agent', strategyDir = '/proj/.stem/context'): ConfigPaths {
  return {
    projectRoot: '/proj',
    configDir: '/proj/.stem',
    configFile: '/proj/.stem/stem.jsonc',
    toolDir,
    agentDir,
    strategyDir,
  }
}

function makeStore(raw?: string): { store: ConfigStore; saved: string[]; text: () => string } {
  const saved: string[] = []
  const store: ConfigStore = {
    file: '/proj/.stem/stem.jsonc',
    async load(): Promise<ConfigLoadResult> {
      if (raw === undefined) return { exists: false, config: {} }
      return { exists: true, config: parseConfigText(raw), raw }
    },
    async save(text: string): Promise<void> {
      saved.push(text)
    },
  }
  return { store, saved, text: () => saved[saved.length - 1] ?? '' }
}

/** 直接子文件（路径以 dir 为前缀且无更深分隔）。 */
function directFiles(files: Record<string, string>, dir: string): string[] {
  const prefix = `${dir}/`
  return Object.keys(files).filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes('/'))
}

/** 直接子目录名（含该目录下有更深层文件即视为目录存在）。 */
function directDirs(files: Record<string, string>, dir: string): string[] {
  const prefix = `${dir}/`
  const seen = new Set<string>()
  for (const f of Object.keys(files)) {
    if (!f.startsWith(prefix)) continue
    const seg = f.slice(prefix.length).split('/')[0]
    if (seg && f !== `${prefix}${seg}`) seen.add(`${prefix}${seg}`)
  }
  return [...seen]
}

/**
 * makeDeps：虚拟文件树驱动（files = readText 树；toolModules = loadTool 树，键 = 完整路径）。
 * extensionRoots 缺省给出 /ext/{tools,agent,context}。
 */
const EXT_ROOTS = { tools: '/ext/tools', agent: '/ext/agent', context: '/ext/context' }

function makeDeps(opts: {
  readonly files?: Readonly<Record<string, string>>
  readonly toolModules?: Readonly<Record<string, unknown>>
  readonly configRaw?: string
  readonly extensionRoots?: InitDeps['extensionRoots']
} = {}) {
  const files: Record<string, string> = { ...(opts.files ?? {}) }
  const { store, saved } = makeStore(opts.configRaw)
  const registry = new DefaultStrategyRegistry()
  const fs: InitFs = {
    listFiles: async (dir) => directFiles(files, dir),
    listDirs: async (dir) => directDirs(files, dir), // 已含 dir 前缀（全路径）
    readText: async (file) => {
      const text = files[file]
      if (text === undefined) throw new Error(`未找到 ${file}`)
      return text
    },
  }
  const loadTool = async (file: string): Promise<{ readonly default?: unknown }> => {
    const mod = (opts.toolModules ?? {})[file]
    if (mod === undefined) throw new Error(`import 失败: ${file}`)
    return { default: mod }
  }
  const deps: InitDeps = {
    config: { store, paths: makePaths() },
    fs,
    tools: { loadTool },
    ...(opts.extensionRoots !== undefined ? { extensionRoots: opts.extensionRoots } : {}),
    toolRegistry: new DefaultToolCapabilityRegistry(),
    templateRegistry: new DefaultTemplateRegistry(),
    strategyRegistry: registry,
    onLog: { log: () => {} },
  }
  return { deps, saved: () => saved[0] ?? '', savedCalls: () => saved.length, registry }
}

/** 工具模块形状（fake 用）。 */
const toolMod = (id: string, marker = id): unknown => ({
  id,
  description: `工具 ${id}`,
  parameters: { type: 'object', properties: {} },
  execute: () => ({ text: marker }),
})

const STRATEGY = '/proj/.stem/context/shouty.ts'
const shoutyModule = {
  name: 'shouty',
  assemble: (input: { messages: readonly { id: string; message: { role: string; content: unknown } }[] }) => ({
    system: '',
    messages: input.messages
      .filter((m) => m.message.role !== 'system')
      .map((m) => ({ role: 'user' as const, content: String(m.message.content).toUpperCase() })),
    messageIds: input.messages.map((m) => m.id),
  }),
}

// ---------- custom 层（目录即真相） ----------

test('首次创建：写默认模板；agent 类目录即真相，工具未点名不进世界', async () => {
  const { deps, saved } = makeDeps({
    files: {
      '/proj/.stem/tools/t1.ts': 'x',
      '/proj/.stem/agent/a1.md': '---\n---\nhello',
    },
    toolModules: { '/proj/.stem/tools/t1.ts': toolMod('t1') },
  })
  const report = await runInit(deps)
  assert.deepEqual(report.tools.map((t) => t.id), [], 'custom 目录扫描已废止——t1 文件存在但未被点名')
  assert.deepEqual(report.agents.map((a) => a.id), ['a1'])
  assert.equal(report.toolInventory.length, 0)
  assert.equal(report.registeredAgents.length, 1)
  const text = saved()
  assert.match(text, /extensions/, '模板含 extensions 点名块')
  assert.doesNotMatch(text, /"t1"|"a1"/, '默认模板不含镜像')
})

test('custom 源点名装载：.stem/tools 文件经 config 点名进世界 + 出生=config 权限词', async () => {
  const { deps } = makeDeps({
    files: { '/proj/.stem/tools/t1.ts': 'x' },
    toolModules: { '/proj/.stem/tools/t1.ts': toolMod('t1') },
    configRaw: '{\n  "providers": { "p": { "base_url": "https://x.dev/v1" } },\n  "user": { "model": "p/m" },\n  "extensions": { "tools": { "t1": "ask" } }\n}',
  })
  const report = await runInit(deps)
  assert.deepEqual(report.tools.map((t) => [t.id, t.layer]), [['t1', 'custom']])
  assert.equal(report.toolInventory[0]?.birth, 'ask', '注册声明 = config 点名权限词（发现段注入）')
})

test('配置文件已存在：永不回写（管线只读 config）', async () => {
  const raw = '{\n  "providers": { "p": { "base_url": "https://x.dev/v1" } },\n  "user": { "model": "p/m" },\n  "extensions": { "tools": { "t1": "allow" } }\n}'
  const { deps, savedCalls } = makeDeps({
    files: {
      '/proj/.stem/tools/t1.ts': 'x',
      '/proj/.stem/agent/a1.md': '---\n---\nhello',
    },
    toolModules: { '/proj/.stem/tools/t1.ts': toolMod('t1') },
    configRaw: raw,
  })
  const report = await runInit(deps)
  assert.equal(savedCalls(), 0)
  assert.equal(report.toolInventory.length, 1)
})

test('旧 ghost 键不再静默丢弃：R12 全量有效原则 → 解析即硬错（可行动指路）', async () => {
  const raw =
    '{\n  "tools": [{"id":"ghost","file":"ghost.ts","kind":"user","enabled":true}],\n  "agents": [{"id":"ghost-agent","file":"ghost.md"}]\n}'
  const { deps } = makeDeps({ configRaw: raw })
  await assert.rejects(
    () => runInit(deps),
    (e: unknown) => {
      const err = e as { kind?: string; message?: string }
      // tools 已升级为配置块（数组形态另有专属迁移错误，见 parse.test）；agents 仍为退役键。
      return err.kind === 'invalid_config' && err.message?.includes('未知配置键 "agents"') === true
    },
  )
})

test('点名工具形状非法 → tool_invalid issue，其余继续', async () => {
  const { deps } = makeDeps({
    configRaw: '{\n  "providers": { "p": { "base_url": "https://x.dev/v1" } },\n  "user": { "model": "p/m" },\n  "extensions": { "tools": { "good": "allow", "bad": "allow" } }\n}',
    files: {
      '/proj/.stem/tools/good.ts': 'x',
      '/proj/.stem/tools/bad.ts': 'x',
    },
    toolModules: {
      '/proj/.stem/tools/good.ts': toolMod('good'),
      '/proj/.stem/tools/bad.ts': { description: '缺 id/execute' },
    },
  })
  const report = await runInit(deps)
  assert.equal(report.issues.length >= 1, true)
  assert.equal(report.issues[0]?.kind, 'tool_invalid')
  assert.equal(report.toolInventory.length, 1)
})

test('agent 文件 frontmatter 非法 → issue，其余继续', async () => {
  const { deps } = makeDeps({
    files: {
      '/proj/.stem/agent/bad.md': 'no frontmatter',
      '/proj/.stem/agent/good.md': '---\n---\nhello',
    },
  })
  const report = await runInit(deps)
  assert.equal(report.issues[0]?.kind, 'agent_parse_failed')
  assert.equal(report.registeredAgents.length, 1)
  assert.equal(report.registeredAgents[0]?.name, 'good')
})

test('用户 agent 注册为完整 AgentClass（id/name 取自文件名）', async () => {
  const { deps } = makeDeps({
    files: {
      '/proj/.stem/agent/reviewer.md': '---\ntools:\n  read: allow\nsend_countdown: 500\n---\nReview system.\n',
    },
  })
  const report = await runInit(deps)
  const cls = report.registeredAgents[0] as AgentClass | undefined
  assert.ok(cls)
  assert.equal(cls.name, makeAgentClassID('reviewer'))
  assert.equal(cls.description, 'reviewer')
  assert.deepEqual(cls.tools, { read: 'allow' })
  assert.equal(cls.sendCountdown, 500)
  assert.match(cls.systemPrompt, /Review system/)
})

test('点名解析：目录形态 `<名>/<名>.ts` 入口 + 附属资源文件不装载', async () => {
  const { deps } = makeDeps({
    configRaw: '{\n  "providers": { "p": { "base_url": "https://x.dev/v1" } },\n  "user": { "model": "p/m" },\n  "extensions": { "tools": { "pkg": "allow" } }\n}',
    files: {
      '/proj/.stem/tools/pkg/pkg.ts': 'x',
      '/proj/.stem/tools/pkg/helper.ts': 'x', // 附属脚本：非入口，不注册
      '/proj/.stem/agent/packed/packed.md': '---\ndescription: 目录形态类\n---\nbody',
      '/proj/.stem/agent/packed/prompt-extra.md': 'x', // 类包附属 md：非入口
    },
    toolModules: { '/proj/.stem/tools/pkg/pkg.ts': toolMod('pkg') },
  })
  const report = await runInit(deps)
  assert.deepEqual(report.toolInventory.map((t) => t.id), ['pkg'])
  assert.deepEqual(report.registeredAgents.map((a) => String(a.name)), ['packed'])
})

test('平铺与目录同名 → 目录形态优先（点名解析序）', async () => {
  const { deps } = makeDeps({
    configRaw: '{\n  "providers": { "p": { "base_url": "https://x.dev/v1" } },\n  "user": { "model": "p/m" },\n  "extensions": { "tools": { "twin": "allow" } }\n}',
    files: {
      '/proj/.stem/tools/twin.ts': 'x',
      '/proj/.stem/tools/twin/twin.ts': 'x',
    },
    toolModules: {
      '/proj/.stem/tools/twin.ts': toolMod('twin', 'flat'),
      '/proj/.stem/tools/twin/twin.ts': toolMod('twin', 'packed'),
    },
  })
  const report = await runInit(deps)
  await drainInventory(deps, report)
  const tool = await deps.toolRegistry.get('twin')
  assert.equal((await tool.execute({}, { agentId: '' })).text, 'packed')
})

// ---------- extension 层（config.extensions 点名，目录形态唯一） ----------

test('extension 点名装载：kind=extension（provenance）+ 报告标层 + 出生=config 词', async () => {
  const raw =
    '{\n  "providers": { "p": { "base_url": "https://x.dev/v1" } },\n  "user": { "model": "p/m" },\n  "extensions": { "tools": { "alpha": "allow" } }\n}'
  const { deps } = makeDeps({
    files: { '/ext/tools/alpha/alpha.ts': 'x' },
    toolModules: { '/ext/tools/alpha/alpha.ts': toolMod('alpha') },
    configRaw: raw,
    extensionRoots: EXT_ROOTS,
  })
  const report = await runInit(deps)
  const alpha = report.tools.find((t) => t.id === 'alpha')
  assert.ok(alpha)
  assert.equal(alpha.layer, 'extension')
  const inv = report.toolInventory.find((t) => t.id === 'alpha')
  assert.equal(inv?.kind, 'extension')
  assert.equal(inv?.birth, 'allow')
})

test('点名不可解析 = boot 硬错（A1 装载源律：config 键必须有文件兑现）', async () => {
  const raw =
    '{\n  "providers": { "p": { "base_url": "https://x.dev/v1" } },\n  "user": { "model": "p/m" },\n  "extensions": { "tools": { "ghost": "allow" } }\n}'
  const { deps } = makeDeps({ files: {}, toolModules: {}, configRaw: raw, extensionRoots: EXT_ROOTS })
  await assert.rejects(
    () => runInit(deps),
    (e: unknown) => (e as { kind?: string }).kind === 'tool_unresolvable',
    'ghost 键两源皆无 → tool_unresolvable 拒启',
  )
})

test('extension agent 点名装载（<名>/<名>.md）', async () => {
  const raw =
    '{\n  "providers": { "p": { "base_url": "https://x.dev/v1" } },\n  "user": { "model": "p/m" },\n  "extensions": { "agent": ["creator"] }\n}'
  const { deps } = makeDeps({
    files: { '/ext/agent/creator/creator.md': '---\ndescription: 调度者\n---\nbody' },
    configRaw: raw,
    extensionRoots: EXT_ROOTS,
  })
  const report = await runInit(deps)
  assert.deepEqual(report.agents.map((a) => [String(a.id), a.layer]), [['creator', 'extension']])
})

test('extension 工厂入口形态：default = (projectRoot) => ToolCapability（loader 注入空间根）', async () => {
  const raw =
    '{\n  "providers": { "p": { "base_url": "https://x.dev/v1" } },\n  "user": { "model": "p/m" },\n  "extensions": { "tools": { "scoped": "allow" } }\n}'
  let receivedRoot = ''
  const factory = (root: string) => {
    receivedRoot = root
    return toolMod('scoped')
  }
  const { deps } = makeDeps({
    files: { '/ext/tools/scoped/scoped.ts': 'x' },
    toolModules: { '/ext/tools/scoped/scoped.ts': factory },
    configRaw: raw,
    extensionRoots: EXT_ROOTS,
  })
  const report = await runInit(deps)
  assert.equal(receivedRoot, '/proj', '工厂应收到 projectRoot')
  assert.equal(report.toolInventory.length, 1)
})

test('宿主未提供 extension 根 = extension 层整体不存在（零 issue）', async () => {
  const { deps } = makeDeps({ extensionRoots: {}, files: {} })
  const report = await runInit(deps)
  assert.deepEqual(report.issues.filter((i) => i.kind === 'extension_entry_missing'), [])
})

test('后层同名覆盖前层 = 装载律（点名 custom 覆盖 pre-registered internal，出生重声明）', async () => {
  const { deps } = makeDeps({
    configRaw: '{\n  "providers": { "p": { "base_url": "https://x.dev/v1" } },\n  "user": { "model": "p/m" },\n  "extensions": { "tools": { "override": "allow" } }\n}',
    files: { '/proj/.stem/tools/override.ts': 'x' },
    toolModules: { '/proj/.stem/tools/override.ts': toolMod('override', 'custom-wins') },
  })
  await deps.toolRegistry.register({
    id: 'override',
    birth: 'ignore',
    description: 'internal 原主',
    parameters: { type: 'object', properties: {} },
    kind: 'internal',
    execute: () => ({ text: 'internal' }),
  })
  const report = await runInit(deps)
  assert.equal(report.issues.length, 0, '覆盖不再是冲突')
  await drainInventory(deps, report)
  const tool = await deps.toolRegistry.get('override')
  assert.equal(tool.kind, 'custom')
  assert.equal(tool.birth, 'allow', '注册声明 = config 点名词（drain 覆盖）')
  assert.equal((await tool.execute({}, { agentId: '' })).text, 'custom-wins')
})

// ---------- 用户上下文策略（custom 扫描 + extension 点名） ----------

test('用户策略：扫描 .stem/context → 注册进策略注册表 + 报告条目', async () => {
  const { deps, saved, registry } = makeDeps({
    files: { [STRATEGY]: 'x' },
    toolModules: { [STRATEGY]: shoutyModule },
  })
  const report = await runInit(deps)
  assert.deepEqual(report.issues.filter((i) => i.kind.startsWith('strategy')), [])
  assert.ok(registry.has('shouty'), '策略应注册进注册表')
  assert.deepEqual(report.strategies.map((s) => [s.id, s.file]), [['shouty', 'shouty.ts']])
  assert.match(saved(), /extensions/, '无配置时写默认模板（不再镜像策略名）')
})

test('用户策略：形状非法（缺 assemble）→ strategy_invalid issue，不中断', async () => {
  const { deps, registry } = makeDeps({
    files: { '/proj/.stem/context/bad.ts': 'x' },
    toolModules: { '/proj/.stem/context/bad.ts': { name: 'bad' } },
  })
  const report = await runInit(deps)
  assert.equal(report.issues[0]?.kind, 'strategy_invalid')
  assert.equal(registry.has('bad'), false)
})

test('用户策略：覆盖内置 classic = 用户主权（后注册生效）', async () => {
  const myClassic = {
    name: 'classic',
    note: 'mine',
    assemble: () => ({ system: '', messages: [], messageIds: [] }),
  }
  const { deps, registry } = makeDeps({
    files: { '/proj/.stem/context/my-classic.ts': 'x' },
    toolModules: { '/proj/.stem/context/my-classic.ts': myClassic },
  })
  // 预置内置同名 → 用户注册覆盖之。
  registry.register({ name: 'classic', assemble: () => ({ system: 'builtin', messages: [], messageIds: [] }) })
  await runInit(deps)
  assert.equal((registry.resolve('classic') as { note?: string }).note, 'mine')
})

test('extension 策略点名装载（context 类目录形态）', async () => {
  const raw =
    '{\n  "providers": { "p": { "base_url": "https://x.dev/v1" } },\n  "user": { "model": "p/m" },\n  "extensions": { "context": ["windowed"] }\n}'
  const mod = { name: 'windowed', assemble: () => ({ system: '', messages: [], messageIds: [] }) }
  const { deps, registry } = makeDeps({
    files: { '/ext/context/windowed/windowed.ts': 'x' },
    toolModules: { '/ext/context/windowed/windowed.ts': mod },
    configRaw: raw,
    extensionRoots: EXT_ROOTS,
  })
  const report = await runInit(deps)
  assert.ok(registry.has('windowed'))
  assert.deepEqual(report.strategies.map((s) => [s.id, s.layer]), [['windowed', 'extension']])
})

test('首启模板 schema-clean 且含根收敛清单实值（DEFAULT_USER_TOOLS 的家）', async () => {
  const { defaultStemConfig } = await import('../config')
  const cfg = defaultStemConfig()
  assert.ok(cfg.user?.tools && cfg.user.tools.access_reply === 'allow', '模板 user.tools 含 access_reply allow')
  assert.equal(cfg.user.tools.mail_send, 'allow', 'bus_* 已更名 mail_*')
  assert.ok(cfg.extensions?.tools && Object.keys(cfg.extensions.tools).length >= 5, '模板点名 fs 五件套')
})
