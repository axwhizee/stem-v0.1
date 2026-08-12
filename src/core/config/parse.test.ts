// ============================================================
// core/config/parse.test.ts —— 配置解析单测
// ============================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfigText, parseModelRef } from './parse'

test('解析完整 JSONC 配置', () => {
  const text = `{
    // 注释
    "model": "opencode-go/deepseek-v4-flash",
    "autoApprove": false,
    "sendCountdown": 800,
    "permission": { "read": "allow", "bash": "ask" },
    "tools": [{ "id": "t1", "file": "tool/t1.ts" }],
    "agents": [{ "id": "a1", "file": "agent/a1.md" }]
  }`
  const config = parseConfigText(text)
  assert.equal(config.model, 'opencode-go/deepseek-v4-flash')
  assert.equal(config.autoApprove, false)
  assert.equal(config.sendCountdown, 800)
  assert.deepEqual(config.permission, { read: 'allow', bash: 'ask' })
  assert.deepEqual(config.tools, [{ id: 't1', file: 'tool/t1.ts', kind: 'user', enabled: true }])
  assert.deepEqual(config.agents, [{ id: 'a1', file: 'agent/a1.md' }])
})

test('解析空对象与尾逗号', () => {
  const config = parseConfigText('{ "model": "p/m", "permission": {}, }')
  assert.equal(config.model, 'p/m')
  assert.deepEqual(config.permission, {})
  assert.equal(config.autoApprove, undefined)
})

test('tools 缺省 enabled=true，enabled=false 保留', () => {
  const config = parseConfigText('{ "tools": [{ "id": "a", "file": "x.ts" }, { "id": "b", "file": "y.ts", "enabled": false }] }')
  assert.equal(config.tools?.[0]?.enabled, true)
  assert.equal(config.tools?.[1]?.enabled, false)
})

test('model 非法（无 /）抛错', () => {
  assert.throws(() => parseConfigText('{ "model": "deepseek-v4-flash" }'), (e: unknown) => {
    return (e as { message?: string }).message?.includes('model') ?? false
  })
})

test('model 必须是字符串', () => {
  assert.throws(() => parseConfigText('{ "model": 123 }'), (e: unknown) => {
    return (e as { message?: string }).message?.includes('model') ?? false
  })
})

test('autoApprove 必须是布尔', () => {
  assert.throws(() => parseConfigText('{ "autoApprove": "yes" }'), (e: unknown) => {
    return (e as { message?: string }).message?.includes('autoApprove') ?? false
  })
})

test('sendCountdown 必须是非负数字', () => {
  assert.throws(() => parseConfigText('{ "sendCountdown": -1 }'), (e: unknown) => {
    return (e as { message?: string }).message?.includes('sendCountdown') ?? false
  })
  assert.throws(() => parseConfigText('{ "sendCountdown": "fast" }'), (e: unknown) => {
    return (e as { message?: string }).message?.includes('sendCountdown') ?? false
  })
})

test('permission 动作非法抛错', () => {
  assert.throws(() => parseConfigText('{ "permission": { "read": "ban" } }'), (e: unknown) => {
    return (e as { message?: string }).message?.includes('permission') ?? false
  })
})

test('配置必须是对象', () => {
  assert.throws(() => parseConfigText('[1,2]'), (e: unknown) => {
    return (e as { message?: string }).message?.includes('对象') ?? false
  })
})

test('JSONC 语法错误抛 config_parse_error', () => {
  assert.throws(() => parseConfigText('{ "model": }'), (e: unknown) => (e as { kind?: string }).kind === 'config_parse_error')
})

test('parseModelRef 拆分 provider/model', () => {
  const fallback = { provider: 'opencode-go', id: 'deepseek-v4-flash' }
  assert.deepEqual(parseModelRef('opencode-go/deepseek-v4-flash', fallback), {
    provider: 'opencode-go',
    id: 'deepseek-v4-flash',
  })
  assert.deepEqual(parseModelRef(undefined, fallback), fallback)
  assert.deepEqual(parseModelRef('bad', fallback), fallback)
})
