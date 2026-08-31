// ============================================================
// core/config/parse.test.ts —— 配置解析单测
// ============================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfigText, parseModelRef } from './parse'

test('解析完整 JSONC 配置（user 对象 + context 块 + 注册表）', () => {
  const text = `{
    // 注释
    "model": "opencode-go/deepseek-v4-flash",
    "autoApprove": false,
    "maxSteps": 8,
    "sendCountdown": 800,
    "user": { "systemPrompt": "你是根。", "permission": { "read": "allow", "bash": "ask" }, "model": "opencode-go/deepseek-v4-flash" },
    "context": { "window": 64000, "compact": { "threshold": 0.9, "keepRecentTurns": 2 } },
    "tools": [{ "id": "t1", "file": "tool/t1.ts" }],
    "agents": [{ "id": "a1", "file": "agent/a1.md" }],
    "strategies": [{ "id": "s1", "file": "context/s1.ts" }]
  }`
  const config = parseConfigText(text)
  assert.equal(config.model, 'opencode-go/deepseek-v4-flash')
  assert.equal(config.autoApprove, false)
  assert.equal(config.maxSteps, 8)
  assert.equal(config.sendCountdown, 800)
  assert.deepEqual(config.user?.permission, { read: 'allow', bash: 'ask' })
  assert.equal(config.user?.systemPrompt, '你是根。')
  assert.deepEqual(config.user?.model, { provider: 'opencode-go', id: 'deepseek-v4-flash' })
  assert.equal(config.context?.window, 64000)
  assert.equal(config.context?.compact?.threshold, 0.9)
  assert.equal(config.context?.compact?.keepRecentTurns, 2)
  assert.deepEqual(config.tools, [{ id: 't1', file: 'tool/t1.ts', kind: 'user', enabled: true }])
  assert.deepEqual(config.agents, [{ id: 'a1', file: 'agent/a1.md' }])
  assert.deepEqual(config.strategies, [{ id: 's1', file: 'context/s1.ts' }])
})

test('user 对象：全部字段可缺省（内置默认由 userClass 兜底）', () => {
  const config = parseConfigText('{ "user": {} }')
  assert.deepEqual(config.user, {})
  assert.equal(config.user?.permission, undefined)
})

test('解析空对象与尾逗号', () => {
  const config = parseConfigText('{ "model": "p/m", "user": { "permission": {} }, }')
  assert.equal(config.model, 'p/m')
  assert.deepEqual(config.user?.permission, {})
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

test('sendCountdown / maxSteps 必须是非负数字', () => {
  assert.throws(() => parseConfigText('{ "sendCountdown": -1 }'), (e: unknown) => {
    return (e as { message?: string }).message?.includes('sendCountdown') ?? false
  })
  assert.throws(() => parseConfigText('{ "maxSteps": "fast" }'), (e: unknown) => {
    return (e as { message?: string }).message?.includes('maxSteps') ?? false
  })
})

test('user.permission 动作非法抛错', () => {
  assert.throws(() => parseConfigText('{ "user": { "permission": { "read": "ban" } } }'), (e: unknown) => {
    return (e as { message?: string }).message?.includes('user.permission.read') ?? false
  })
})

test('user 必须是对象 / user.model 格式校验', () => {
  assert.throws(() => parseConfigText('{ "user": [] }'), (e: unknown) => (e as { message?: string }).message?.includes('user'))
  assert.throws(
    () => parseConfigText('{ "user": { "model": "no-slash" } }'),
    (e: unknown) => (e as { message?: string }).message?.includes('user.model'),
  )
})

test('context 校验：类型 + threshold 上限', () => {
  assert.throws(() => parseConfigText('{ "context": 42 }'), (e: unknown) => (e as { message?: string }).message?.includes('context'))
  assert.throws(
    () => parseConfigText('{ "context": { "compact": { "threshold": 1.5 } } }'),
    (e: unknown) => (e as { message?: string }).message?.includes('threshold'),
  )
  assert.throws(
    () => parseConfigText('{ "context": { "compact": { "summarizeModel": "bad" } } }'),
    (e: unknown) => (e as { message?: string }).message?.includes('summarizeModel'),
  )
})

test('strategies 镜像条目校验', () => {
  assert.throws(() => parseConfigText('{ "strategies": [{ "id": "s1" }] }'), (e: unknown) => {
    return (e as { message?: string }).message?.includes('strategies[0].file') ?? false
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
