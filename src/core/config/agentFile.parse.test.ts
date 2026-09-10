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
metadata:
  author: someone
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
  // 融合：工具白名单 = tools 的键。
  assert.deepEqual(parsed.tools, ['read', 'glob', 'edit'])
  assert.equal(parsed.sendCountdown, 800)
  assert.match(parsed.systemPrompt, /senior code reviewer/)
  assert.match(parsed.systemPrompt, /Be concise\./)
})

test('不读 frontmatter 的 id/name，一律用文件名', () => {
  const parsed = parseAgentFile('---\nid: other\nname: Other\n---\nbody', 'my-agent')
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

// ---------- S3′：自由式 frontmatter（context_strategy / model / custom 透传） ----------

test('context_strategy / model 已知键提取', () => {
  const parsed = parseAgentFile(
    '---\ndescription: x\ncontext_strategy: self_focus\nmodel: opencode-go/deepseek-v4-flash\n---\nbody',
    'agent-x',
  )
  assert.equal(parsed.contextStrategy, 'self_focus')
  assert.deepEqual(parsed.model, { provider: 'opencode-go', id: 'deepseek-v4-flash' })
})

test('未知字段透传 custom（自定义扩展位不丢弃）', () => {
  const parsed = parseAgentFile('---\ndescription: x\nmetadata:\n  author: owl\ntags:\n  - a\n---\nbody', 'agent-y')
  assert.deepEqual(parsed.custom, { metadata: { author: 'owl' }, tags: ['a'] })
})

test('无未知字段 → custom 空对象', () => {
  const parsed = parseAgentFile('---\ndescription: x\n---\nbody', 'agent-z')
  assert.deepEqual(parsed.custom, {})
})

test('model 缺斜杠抛错', () => {
  assert.throws(() => parseAgentFile('---\nmodel: no-slash\n---\nbody', 'bad'), /提供商\/模型/)
})

test('context_strategy 类型非法抛错', () => {
  assert.throws(() => parseAgentFile('---\ncontext_strategy: 42\n---\nbody', 'bad'), /context_strategy/)
})

test('完整样例：SAMPLE 的 metadata 进 custom（旧"忽略"→新"透传"）', () => {
  const parsed = parseAgentFile(SAMPLE, 'user-reviewer')
  assert.deepEqual(parsed.custom, { metadata: { author: 'someone' } })
})
