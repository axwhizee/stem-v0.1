// ============================================================
// core/config/parse.test.ts —— 配置解析单测（S6 验收矩阵）
//
// 覆盖：providers 校验（R13）/ 全量有效原则（R12 未知键 fail-fast）/
// 模型引用 × 注册表交叉校验 / 各块类型校验 / 首启模板自洽。
// ============================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfigText } from './parse'
import { DEFAULT_CONFIG_TEXT, defaultStemConfig } from './defaults'

/** 断言解析抛 invalid_config 且消息含指定片段。 */
function expectFail(text: string, ...fragments: string[]): void {
  assert.throws(
    () => parseConfigText(text),
    (e: unknown) => {
      const err = e as { kind?: string; message?: string }
      if (err.kind !== 'invalid_config') return false
      return fragments.every((f) => err.message?.includes(f) ?? false)
    },
    `应抛 invalid_config 且含 ${fragments.join(' + ')}`,
  )
}

// ---------- providers（R13） ----------

test('providers 完整形状解析（base_url/key_env/models）', () => {
  const config = parseConfigText(`{
    "providers": {
      "alibaba": { "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "key_env": "ALIBABA_API_KEY", "models": ["qwen3.8-flash", "qwen3.8-max"] },
      "local": { "base_url": "http://127.0.0.1:11434/v1" }
    },
    "user": { "model": "alibaba/qwen3.8-flash" , "displayName": "船长"}
  }`)
  assert.deepEqual(config.providers?.alibaba, {
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    key_env: 'ALIBABA_API_KEY',
    models: ['qwen3.8-flash', 'qwen3.8-max'],
  })
  assert.deepEqual(config.providers?.local, { base_url: 'http://127.0.0.1:11434/v1' })
})

test('providers 校验矩阵：缺 base_url / 非 http(s) / 非对象 / 未知键 / key_env 空 / models 非串', () => {
  expectFail('{ "providers": { "a": { "key_env": "K" } } }', 'providers.a.base_url', '必填')
  expectFail('{ "providers": { "a": { "base_url": "ftp://x" } } }', 'providers.a.base_url')
  expectFail('{ "providers": { "a": [] } }', 'providers.a 必须是对象')
  expectFail('{ "providers": { "a": { "base_url": "https://x", "kind": "openai" } } }', 'providers.a.kind', '未知键')
  expectFail('{ "providers": { "a": { "base_url": "https://x", "key_env": "" } } }', 'key_env')
  expectFail('{ "providers": { "a": { "base_url": "https://x", "models": [42] } } }', 'models[0]')
  expectFail('{ "providers": 42 }', 'providers 必须是对象')
})

// ---------- 模型引用 × 注册表交叉校验 ----------

test('user.model 的 provider 未注册 → fail-fast 并列出已注册', () => {
  expectFail(
    '{ "providers": { "a": { "base_url": "https://x" } }, "user": { "model": "b/m" } }',
    'user.model',
    '"b" 未在 providers 注册',
    'a',
  )
})

test('user.model 不在 models 白名单 → fail-fast（空数组 = 全启用）', () => {
  expectFail(
    '{ "providers": { "a": { "base_url": "https://x", "models": ["m1"] } }, "user": { "model": "a/m2" } }',
    'user.model',
    '未启用',
  )
  const ok = parseConfigText(
    '{ "providers": { "a": { "base_url": "https://x", "models": [] } }, "user": { "model": "a/anything" } }',
  )
  assert.deepEqual(ok.user?.model, { provider: 'a', id: 'anything' })
})

test('summarizeModel 同样对拍注册表', () => {
  expectFail(
    '{ "context": { "compact": { "summarizeModel": "ghost/mini" } } }',
    'context.compact.summarizeModel',
    '未在 providers 注册',
  )
})

// ---------- 全量有效原则（R12） ----------

test('未知顶层键 fail-fast；custom 是唯一合法扩展位', () => {
  expectFail('{ "temperature": 0.7 }', '未知配置键 "temperature"')
  parseConfigText('{ "custom": { "anything": [1, 2] } }') // 不抛
  assert.deepEqual(parseConfigText('{ "custom": { "k": 1 } }').custom, { k: 1 })
})

test('已废除历史键 → fail-fast 且错误可行动（指路新家）', () => {
  expectFail('{ "model": "opencode-go/x" }', '未知配置键 "model"', '家学锚点 = user.model')
  expectFail('{ "tools": [] }', '目录即真相')
  expectFail('{ "agents": {} }', '目录即真相')
  expectFail('{ "strategies": [] }', '目录即真相')
})

test('model 必须 "提供商/模型" 严格式（两段皆非空）', () => {
  expectFail('{ "user": { "model": "no-slash" } }', 'user.model')
  expectFail('{ "user": { "model": "/leading" } }', 'user.model')
  expectFail('{ "user": { "model": "trailing/" } }', 'user.model')
})

// ---------- 其余块类型校验 ----------

test('解析完整 JSONC（注释 + 尾逗号 + 全块）', () => {
  const config = parseConfigText(`{
    // 注释
    "providers": { "opencode-go": { "base_url": "https://opencode.ai/zen/go/v1", "key_env": "OPENCODE_API_KEY" } },
    "autoApprove": false,
    "maxSteps": 8,
    "sendCountdown": 800,
    "user": { "systemPrompt": "你是根。", "tools": { "read": "allow", "bash": "ask" }, "model": "opencode-go/deepseek-v4-flash", "displayName": "船长" },
    "context": { "window": 64000, "compact": { "threshold": 0.9, "keepRecentTurns": 2, "summarizeModel": "opencode-go/deepseek-v4-flash" } },
    "extensions": { "tools": ["read", "vscode"], "agent": ["creator"] },
  }`)
  assert.equal(config.autoApprove, false)
  assert.equal(config.maxSteps, 8)
  assert.equal(config.sendCountdown, 800)
  assert.deepEqual(config.user?.tools, { read: 'allow', bash: 'ask' })
  assert.equal(config.user?.systemPrompt, '你是根。')
  assert.deepEqual(config.user?.model, { provider: 'opencode-go', id: 'deepseek-v4-flash' })
  assert.equal(config.user?.displayName, '船长', 'displayName 是白名单字段，parse 不得丢弃（v1.0 实测抓获回归）')
  assert.equal(config.context?.window, 64000)
  assert.equal(config.context?.compact?.threshold, 0.9)
  assert.deepEqual(config.extensions, { tools: ['read', 'vscode'], agent: ['creator'] })
})

test('autoApprove 必须是布尔', () => {
  expectFail('{ "autoApprove": "yes" }', 'autoApprove')
})

test('sendCountdown / maxSteps 必须是非负数字', () => {
  expectFail('{ "sendCountdown": -1 }', 'sendCountdown')
  expectFail('{ "maxSteps": "fast" }', 'maxSteps')
})

test('user.tools 动作非法抛错（四态）', () => {
  expectFail('{ "user": { "tools": { "read": "ban" } } }', 'user.tools.read')
})

test('user 必须是对象', () => {
  expectFail('{ "user": [] }', 'user 必须是对象')
})

test('context 校验：类型 + threshold 上限', () => {
  expectFail('{ "context": 42 }', 'context')
  expectFail('{ "context": { "compact": { "threshold": 1.5 } } }', 'threshold')
  expectFail('{ "context": { "compact": { "summarizeModel": "bad" } } }', 'summarizeModel')
})

test('bash 块：解析 + 类型校验', () => {
  const config = parseConfigText(
    '{ "bash": { "path": "/bin/dash", "defaultTimeoutMs": 30000, "maxOutputChars": 1000, "cwd": "sub" } }',
  )
  assert.deepEqual(config.bash, { path: '/bin/dash', defaultTimeoutMs: 30000, maxOutputChars: 1000, cwd: 'sub' })
  expectFail('{ "bash": [] }', 'bash')
  expectFail('{ "bash": { "path": 42 } }', 'bash.path')
  expectFail('{ "bash": { "defaultTimeoutMs": -1 } }', 'defaultTimeoutMs')
})

test('extensions：分键对象（S7 矩阵）+ 旧数组形态拒启指路', () => {
  assert.deepEqual(parseConfigText('{ "extensions": { "tools": [] } }').extensions, { tools: [] })
  assert.deepEqual(parseConfigText('{ "extensions": {} }').extensions, {})
  assert.equal(parseConfigText('{}').extensions, undefined)
  expectFail('{ "extensions": ["fs"] }', '已退役')
  expectFail('{ "extensions": { "strategies": [] } }', '未知键')
  expectFail('{ "extensions": { "tools": [42] } }', 'extensions.tools[0]')
})

test('配置必须是对象；JSONC 语法错误抛 config_parse_error', () => {
  expectFail('[1,2]', '配置必须是 JSON 对象')
  assert.throws(() => parseConfigText('{ "providers": }'), (e: unknown) => (e as { kind?: string }).kind === 'config_parse_error')
})

// ---------- 首启模板（R2：预设 = 模板数据） ----------

test('DEFAULT_CONFIG_TEXT 自洽：schema 全量校验通过', () => {
  const config = defaultStemConfig()
  // extensions 键在模板中为注释示例（缺省行为 = core 兜底默认表），不占实数据键。
  assert.deepEqual(Object.keys(config).sort(), ['autoApprove', 'context', 'providers', 'sendCountdown', 'user'])
})

test('模板含唯一预设 opencode-go + 家学锚点 user.model（零代码常量的数据形态）', () => {
  const config = defaultStemConfig()
  assert.equal(config.providers?.['opencode-go']?.base_url, 'https://opencode.ai/zen/go/v1')
  assert.equal(config.providers?.['opencode-go']?.key_env, 'OPENCODE_API_KEY')
  assert.deepEqual(config.user?.model, { provider: 'opencode-go', id: 'deepseek-v4-flash' })
  assert.ok(DEFAULT_CONFIG_TEXT.includes('key_env'))
})
