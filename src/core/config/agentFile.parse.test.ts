// ============================================================
// core/config/agentFile.parse.test.ts —— 用户 agent 文件解析单测
// ============================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAgentFile, parseFrontmatter, extractPrompt } from './agentFile'

const SAMPLE = `---
description: 代码审查员
tools:
  read: allow
  glob: allow
  edit: deny
send_countdown: 800
temperature: 0.3
effort: medium
---
You are a senior code reviewer.
Be concise.
`

test('解析完整 agent 文件（文件名即 id/name）', () => {
  const parsed = parseAgentFile(SAMPLE, 'user-reviewer')
  assert.equal(parsed.id, 'user-reviewer')
  assert.equal(parsed.name, 'user-reviewer')
  assert.equal(parsed.description, '代码审查员')
  assert.deepEqual(parsed.toolAccess, { read: 'allow', glob: 'allow', edit: 'deny' })
  assert.deepEqual(parsed.tools, ['read', 'glob', 'edit'])
  assert.equal(parsed.sendCountdown, 800)
  assert.equal(parsed.temperature, 0.3)
  assert.equal(parsed.effort, 'medium')
  assert.match(parsed.systemPrompt, /senior code reviewer/)
})

test('不读 frontmatter 的 id/name，一律用文件名', () => {
  const parsed = parseAgentFile('---\ndescription: Other\n---\nbody', 'my-agent')
  assert.equal(parsed.id, 'my-agent')
  assert.equal(parsed.name, 'my-agent')
})

test('description 缺省 = 文件名', () => {
  const parsed = parseAgentFile('---\n---\nbody', 'foo')
  assert.equal(parsed.description, 'foo')
})

test('无 tools → 无工具', () => {
  const parsed = parseAgentFile('---\ndescription: x\n---\nbody', 'foo')
  assert.deepEqual(parsed.toolAccess, {})
  assert.deepEqual(parsed.tools, [])
})

test('send_countdown 缺省不输出', () => {
  const parsed = parseAgentFile('---\ndescription: x\n---\nbody', 'foo')
  assert.equal(parsed.sendCountdown, undefined)
})

test('缺 frontmatter 抛错', () => {
  assert.throws(() => parseAgentFile('just text', 'foo'), /frontmatter/)
})

test('tools 动作非法抛错', () => {
  assert.throws(() => parseAgentFile('---\ntools:\n  read: ban\n---\nbody', 'foo'), /allow/)
})

test('frontmatter 必须是对象', () => {
  assert.throws(() => parseFrontmatter('---\n- a\n- b\n---\nbody'), /对象/)
})

test('extractPrompt 提取正文并 trim', () => {
  assert.equal(extractPrompt('---\ndescription: x\n---\n\n  hello world  \n'), 'hello world')
})

test('context_strategy / model 已知键提取', () => {
  const parsed = parseAgentFile(
    '---\ndescription: x\ncontext_strategy: self_focus\nmodel: opencode-go/deepseek-v4-flash\n---\nbody',
    'agent-x',
  )
  assert.equal(parsed.contextStrategy, 'self_focus')
  assert.deepEqual(parsed.model, { provider: 'opencode-go', id: 'deepseek-v4-flash' })
})

test('未知字段拒收（custom 槽已退役）', () => {
  assert.throws(() => parseAgentFile('---\nmetadata:\n  author: owl\n---\nbody', 'agent-y'), /未知字段/)
})

test('model 缺斜杠抛错', () => {
  assert.throws(() => parseAgentFile('---\nmodel: no-slash\n---\nbody', 'bad'), /提供商\/模型/)
})

test('context_strategy 类型非法抛错', () => {
  assert.throws(() => parseAgentFile('---\ncontext_strategy: 42\n---\nbody', 'bad'), /context_strategy/)
})

test('effort 非法枚举抛错', () => {
  assert.throws(() => parseAgentFile('---\neffort: turbo\n---\nbody', 'bad'), /effort/)
})
