// ============================================================
// shell/config/nodeConfig.test.ts —— node fs 配置集成测试
//
// 用真实临时目录验证：read/store → init 同步注册表 → 注册进
// registry，以及用户工具/agent 文件被正确加载。
// ============================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runInit } from '../../../src/core/init'
import { DefaultToolCapabilityRegistry } from '../../../src/core/tools'
import { DefaultTemplateRegistry } from '../../../src/core/kernel'
import { createNodeConfigBundle } from './nodeConfig'

async function makeProjectSpace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'stem-config-'))
  await mkdir(join(dir, '.stem', 'tools'), { recursive: true })
  await mkdir(join(dir, '.stem', 'agent'), { recursive: true })
  return dir
}

const AGENT_TEXT = `---
description: 我的审查员
tools:
  read: allow
send_countdown: 700
---
You review code.
`

const TOOL_TEXT = `import type { ToolCapability } from '../../../src/core/tools'

const tool: ToolCapability = {
  id: 'my_tool',
  description: '测试工具',
  parameters: { type: 'object', properties: {} },
  execute: () => ({ text: 'ok' }),
}

export default tool
`

test('真实 fs：init 创建配置、登记工具/agent、注册进 core', async () => {
  const dir = await makeProjectSpace()
  try {
    // 写工具 + agent 文件。
    await writeFile(join(dir, '.stem', 'tools', 'my_tool.ts'), TOOL_TEXT)
    await writeFile(join(dir, '.stem', 'agent', 'my-reviewer.md'), AGENT_TEXT)

    const bundle = createNodeConfigBundle(dir)
    const toolRegistry = new DefaultToolCapabilityRegistry()
    const templateRegistry = new DefaultTemplateRegistry()

    const report = await runInit({
      config: { store: bundle.store, paths: bundle.paths },
      fs: bundle.fs,
      tools: { loadTool: bundle.loadTool },
      toolRegistry,
      templateRegistry,
      onLog: { log: () => {} },
    })

    assert.equal(report.issues.length, 0, JSON.stringify(report.issues))
    assert.deepEqual(report.tools.map((t) => t.id), ['my_tool'])
    assert.deepEqual(report.agents.map((a) => a.id), ['my-reviewer'])
    assert.equal(report.registeredTools.length, 1)
    assert.equal(report.registeredAgents.length, 1)

    // 配置文件不存在 → 写入默认模板；目录即真相，不回写镜像登记。
    const text = await readFile(join(dir, '.stem', 'stem.jsonc'), 'utf8')
    assert.match(text, /"extensions"/)
    assert.doesNotMatch(text, /my_tool|my-reviewer/, '不再有镜像写回')

    // registry 中可查到用户工具。
    const tool = await toolRegistry.get('my_tool')
    assert.equal(tool.kind, 'user')
    assert.equal(tool.description, '测试工具')

    // 模板注册表可查到用户 agent。
    const cls = await templateRegistry.get('my-reviewer' as never)
    assert.equal(cls.sendCountdown, 700)
    assert.match(cls.systemPrompt, /You review code/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('真实 fs：旧镜像 ghost 键 → R12 解析硬错（不再静默丢弃）', async () => {
  const dir = await makeProjectSpace()
  try {
    // S4.2 兼容层已废除：幽灵镜像键在解析期即 fail-fast（config 即全部配置）。
    const ghostConfig = `{
      "tools": [{ "id": "ghost", "file": "ghost.ts", "kind": "user", "enabled": true }],
      "agents": [{ "id": "ghost-agent", "file": "ghost-agent.md" }]
    }`
    await writeFile(join(dir, '.stem', 'stem.jsonc'), ghostConfig)

    const bundle = createNodeConfigBundle(dir)
    await assert.rejects(
      () => bundle.store.load(),
      (e: unknown) => {
        const err = e as { kind?: string; message?: string }
        return err.kind === 'invalid_config' && err.message?.includes('未知配置键') === true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('真实 fs：providers + 家学 user.model 解析（S6/R12 后 config 唯一模型面）', async () => {
  const dir = await makeProjectSpace()
  try {
    await writeFile(
      join(dir, '.stem', 'stem.jsonc'),
      '{ "providers": { "dash": { "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "key_env": "DASH_KEY" } }, "user": { "model": "dash/qwen3.8-flash" } }',
    )
    const bundle = createNodeConfigBundle(dir)
    const loaded = await bundle.store.load()
    assert.equal(loaded.config.providers?.dash?.key_env, 'DASH_KEY')
    assert.deepEqual(loaded.config.user?.model, { provider: 'dash', id: 'qwen3.8-flash' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
