// ============================================================
// core/init/init.test.ts —— 初始化管线单测（内存 fake）
// ============================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConfigLoadResult, ConfigPaths, ConfigStore } from '../config'
import { parseConfigText } from '../config'
import type { AgentClass, AgentClassID } from '../kernel'
import { makeAgentClassID } from '../kernel'
import type { ToolCapability } from '../tools'
import { DefaultToolCapabilityRegistry } from '../tools'
import { DefaultAgentTemplateRegistry } from '../kernel'
import { runInit } from './init'
import type { InitDeps, InitFs } from './types'

function makePaths(toolDir = '/proj/.stem/tool', agentDir = '/proj/.stem/agent'): ConfigPaths {
  return {
    projectRoot: '/proj',
    configDir: '/proj/.stem',
    configFile: '/proj/.stem/stem.jsonc',
    toolDir,
    agentDir,
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

interface ToolFile {
  readonly id: string
  readonly body?: Partial<ToolCapability>
}

function makeDeps(opts: {
  readonly toolFiles?: readonly ToolFile[]
  readonly agentTexts?: ReadonlyArray<{ readonly file: string; readonly text: string }>
  readonly configRaw?: string
  readonly brokenTool?: boolean
}): { deps: InitDeps; saved: () => string; savedCalls: () => number } {
  const { store, saved } = makeStore(opts.configRaw)
  let saveCalls = 0
  const fs: InitFs = {
    async listFiles(dir: string): Promise<readonly string[]> {
      if (dir.endsWith('/tool')) return (opts.toolFiles ?? []).map((t) => `/proj/.stem/tool/${t.id}.ts`)
      if (dir.endsWith('/agent')) return (opts.agentTexts ?? []).map((a) => `/proj/.stem/agent/${a.file}`)
      return []
    },
    async readText(file: string): Promise<string> {
      const found = (opts.agentTexts ?? []).find((a) => `/proj/.stem/agent/${a.file}` === file)
      if (found) return found.text
      throw new Error(`未找到 ${file}`)
    },
  }
  const loadTool = async (file: string): Promise<{ readonly default?: unknown }> => {
    if (opts.brokenTool) throw new Error('import 失败')
    const id = file.split('/').pop()?.replace(/\.ts$/, '')
    const spec = (opts.toolFiles ?? []).find((t) => `${t.id}.ts` === `${id}.ts`)
    if (!spec) return {}
    return {
      default: {
        id: spec.id,
        description: spec.body?.description ?? `工具 ${spec.id}`,
        parameters: spec.body?.parameters ?? { type: 'object', properties: {} },
        execute: spec.body?.execute ?? (() => ({ text: 'ok' })),
      },
    }
  }
  const deps: InitDeps = {
    config: { store, paths: makePaths() },
    fs,
    tools: { loadTool },
    toolRegistry: new DefaultToolCapabilityRegistry(),
    templateRegistry: new DefaultAgentTemplateRegistry(),
    onLog: { log: () => {} },
  }
  return { deps, saved: () => saved[0] ?? '', savedCalls: () => saveCalls }
}

test('首次创建：无配置时生成默认配置并登记工具/agent', async () => {
  const { deps, saved } = makeDeps({
    toolFiles: [{ id: 't1' }],
    agentTexts: [{ file: 'a1.md', text: '---\n---\nhello' }],
  })
  const report = await runInit(deps)
  assert.deepEqual(report.tools.map((t) => t.id), ['t1'])
  assert.deepEqual(report.agents.map((a) => a.id), ['a1'])
  assert.equal(report.registeredTools.length, 1)
  assert.equal(report.registeredAgents.length, 1)
  assert.deepEqual(report.issues, [])
  const text = saved()
  assert.match(text, /"t1"/)
  assert.match(text, /"a1"/)
})

test('再次运行：注册表不变时不写回', async () => {
  const raw = '{\n  "model": "opencode-go/deepseek-v4-flash",\n  "tools": [{"id":"t1","file":"t1.ts","kind":"user","enabled":true}],\n  "agents": [{"id":"a1","file":"a1.md"}]\n}'
  const { deps, savedCalls } = makeDeps({
    toolFiles: [{ id: 't1' }],
    agentTexts: [{ file: 'a1.md', text: '---\n---\nhello' }],
    configRaw: raw,
  })
  const report = await runInit(deps)
  assert.equal(savedCalls(), 0)
  assert.deepEqual(report.issues, [])
})

test('已注册但无实现文件 → orphan_registration issue', async () => {
  const raw =
    '{\n  "tools": [{"id":"ghost","file":"ghost.ts","kind":"user","enabled":true}],\n  "agents": [{"id":"ghost-agent","file":"ghost.md"}]\n}'
  const { deps } = makeDeps({
    toolFiles: [{ id: 't1' }],
    agentTexts: [{ file: 'a1.md', text: '---\n---\nhello' }],
    configRaw: raw,
  })
  const report = await runInit(deps)
  const orphans = report.issues.filter((i) => i.kind === 'orphan_registration')
  const orphanTools = orphans.filter(
    (i): i is { readonly kind: 'orphan_registration'; readonly type: 'tool'; readonly id: string; readonly file: string } =>
      i.type === 'tool',
  )
  const orphanAgents = orphans.filter(
    (i): i is { readonly kind: 'orphan_registration'; readonly type: 'agent'; readonly id: string; readonly file: string } =>
      i.type === 'agent',
  )
  assert.equal(orphanTools.length, 1)
  assert.equal(orphanTools[0]?.id, 'ghost')
  assert.equal(orphanAgents.length, 1)
  assert.equal(orphanAgents[0]?.id, 'ghost-agent')
})

test('工具加载失败 → issue，其余继续', async () => {
  const { deps } = makeDeps({
    toolFiles: [{ id: 't1' }],
    agentTexts: [],
    brokenTool: true,
  })
  const report = await runInit(deps)
  assert.equal(report.issues.length, 1)
  assert.equal(report.issues[0]?.kind, 'tool_load_failed')
  assert.equal(report.registeredTools.length, 0)
})

test('agent 文件 frontmatter 非法 → issue，其余继续', async () => {
  const { deps } = makeDeps({
    toolFiles: [],
    agentTexts: [
      { file: 'bad.md', text: 'no frontmatter' },
      { file: 'good.md', text: '---\n---\nhello' },
    ],
  })
  const report = await runInit(deps)
  assert.equal(report.issues.length, 1)
  assert.equal(report.issues[0]?.kind, 'agent_parse_failed')
  assert.equal(report.registeredAgents.length, 1)
  assert.equal(report.registeredAgents[0]?.id, 'good')
})

test('用户 agent 注册为完整 AgentClass（id/name 取自文件名）', async () => {
  const { deps } = makeDeps({
    toolFiles: [],
    agentTexts: [
      { file: 'reviewer.md', text: '---\npermission:\n  read: allow\nsend_countdown: 500\n---\nReview system.\n' },
    ],
  })
  const report = await runInit(deps)
  const cls = report.registeredAgents[0] as AgentClass | undefined
  assert.ok(cls)
  assert.equal(cls.id, makeAgentClassID('reviewer'))
  assert.equal(cls.name, 'reviewer')
  assert.equal(cls.description, 'reviewer')
  assert.deepEqual(cls.permissions, { read: 'allow' })
  assert.deepEqual(cls.tools.map((t) => t.id), ['read'])
  assert.equal(cls.sendCountdown, 500)
  assert.match(cls.systemPrompt, /Review system/)
})

test('工具已注册冲突 → issue 不抛错', async () => {
  const { deps } = makeDeps({ toolFiles: [{ id: 'dup' }], agentTexts: [] })
  await deps.toolRegistry.register({
    id: 'dup',
    description: '已存在的工具',
    parameters: { type: 'object', properties: {} },
    execute: () => ({ text: 'x' }),
  })
  const report = await runInit(deps)
  assert.equal(report.issues.length, 1)
  assert.equal(report.issues[0]?.kind, 'tool_invalid')
  assert.equal(report.registeredTools.length, 0)
})
