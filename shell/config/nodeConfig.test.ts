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
import { runInit } from '../../src/core/init'
import { DefaultToolCapabilityRegistry } from '../../src/core/tools'
import { DefaultAgentTemplateRegistry } from '../../src/core/kernel'
import { createNodeConfigBundle } from './nodeConfig'

async function makeProjectSpace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'stem-config-'))
  await mkdir(join(dir, '.stem', 'tool'), { recursive: true })
  await mkdir(join(dir, '.stem', 'agent'), { recursive: true })
  return dir
}

const AGENT_TEXT = `---
description: 我的审查员
permission:
  read: allow
send_countdown: 700
---
You review code.
`

const TOOL_TEXT = `import type { ToolCapability } from '../../src/core/tools'

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
    await writeFile(join(dir, '.stem', 'tool', 'my_tool.ts'), TOOL_TEXT)
    await writeFile(join(dir, '.stem', 'agent', 'my-reviewer.md'), AGENT_TEXT)

    const bundle = createNodeConfigBundle(dir)
    const toolRegistry = new DefaultToolCapabilityRegistry()
    const templateRegistry = new DefaultAgentTemplateRegistry()

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

    // 配置已写回（纯镜像）。
    const text = await readFile(join(dir, '.stem', 'stem.jsonc'), 'utf8')
    assert.match(text, /"my_tool"/)
    assert.match(text, /"my-reviewer"/)

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

test('真实 fs：已注册但无实现文件 → orphan issue 并从镜像移除', async () => {
  const dir = await makeProjectSpace()
  try {
    // 先写一个配置文件（含幽灵注册）。
    const ghostConfig = `{
      "tools": [{ "id": "ghost", "file": "ghost.ts", "kind": "user", "enabled": true }],
      "agents": [{ "id": "ghost-agent", "file": "ghost-agent.md" }]
    }`
    await writeFile(join(dir, '.stem', 'stem.jsonc'), ghostConfig)

    const bundle = createNodeConfigBundle(dir)
    const report = await runInit({
      config: { store: bundle.store, paths: bundle.paths },
      fs: bundle.fs,
      tools: { loadTool: bundle.loadTool },
      toolRegistry: new DefaultToolCapabilityRegistry(),
      templateRegistry: new DefaultAgentTemplateRegistry(),
      onLog: { log: () => {} },
    })

    const orphans = report.issues.filter((i) => i.kind === 'orphan_registration')
    assert.equal(orphans.length, 2)
    assert.deepEqual(report.tools, [])
    assert.deepEqual(report.agents, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('真实 fs：模型引用解析', async () => {
  const dir = await makeProjectSpace()
  try {
    await writeFile(join(dir, '.stem', 'stem.jsonc'), '{ "model": "opencode-go/deepseek-v4-flash" }')
    const bundle = createNodeConfigBundle(dir)
    const loaded = await bundle.store.load()
    assert.equal(loaded.config.model, 'opencode-go/deepseek-v4-flash')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
