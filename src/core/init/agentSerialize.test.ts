// ============================================================
// core/init/agentSerialize.test.ts —— 类序列化器单测（S5.2 往返律）
//
// 核心契约：parse(serialize(cls), name) ≡ normalize(cls)。
// 红线：panel 类永不序列化；custom 与已知键冲突拒绝；类名字符集守卫。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { makeAgentClassID, type AgentClass } from '../kernel'
import { parseAgentFile } from './agentParse'
import { serializeAgentClass, agentFileName, agentFileOf } from './agentSerialize'

const full: AgentClass = {
  name: makeAgentClassID('reviewer'),
  description: '代码审查专家：读 diff、给结论。',
  systemPrompt: '你是审查者。\n输出三点结论：\n- 正确性\n- 风险\n- 建议',
  tools: { read: 'allow', edit: 'ask', bash: 'deny', skill: 'ignore' },
  sendCountdown: 1500,
  contextStrategy: 'classic',
  model: { provider: 'opencode-go', id: 'deepseek-v4-flash' },
  custom: { gen: 2, tags: ['review', 'v2'], dream: { everyMs: 60000, idleOnly: true } },
}

describe('serializeAgentClass（往返律：parse ∘ serialize ≡ id）', () => {
  test('全字段类往返无损（含四态 tools / custom 自由键 / model 字符串化）', () => {
    const text = serializeAgentClass(full)
    const parsed = parseAgentFile(text, 'reviewer')
    assert.equal(parsed.name, 'reviewer')
    assert.equal(parsed.description, full.description)
    assert.deepEqual(parsed.toolAccess, full.tools, '四态工具清单原样往返')
    assert.equal(parsed.sendCountdown, 1500)
    assert.equal(parsed.contextStrategy, 'classic')
    assert.deepEqual(parsed.model, { provider: 'opencode-go', id: 'deepseek-v4-flash' })
    assert.deepEqual(parsed.custom, full.custom, 'custom 自由键（对象/数组）透传往返')
    assert.equal(parsed.systemPrompt, full.systemPrompt)
  })

  test('最简类往返（空 tools = 封闭无工具；可选键不产出）', () => {
    const cls: AgentClass = {
      name: makeAgentClassID('plain'),
      description: 'd',
      systemPrompt: 'p',
      tools: {},
    }
    const parsed = parseAgentFile(serializeAgentClass(cls), 'plain')
    assert.deepEqual(parsed.toolAccess, {}, 'tools={} 必须写出（≠ 缺键语义）')
    assert.ok(!('sendCountdown' in parsed) && !('contextStrategy' in parsed) && !('model' in parsed))
    assert.deepEqual(parsed.custom, {})
  })

  test('二次往返稳定（serialize(parse(serialize(cls))) === serialize(cls)）', () => {
    const once = serializeAgentClass(full)
    const reparsed = parseAgentFile(once, 'reviewer')
    const again = serializeAgentClass({
      name: makeAgentClassID('reviewer'),
      description: reparsed.description,
      systemPrompt: reparsed.systemPrompt,
      tools: reparsed.toolAccess,
      ...(reparsed.sendCountdown !== undefined ? { sendCountdown: reparsed.sendCountdown } : {}),
      ...(reparsed.contextStrategy !== undefined ? { contextStrategy: reparsed.contextStrategy } : {}),
      ...(reparsed.model !== undefined ? { model: reparsed.model } : {}),
      ...(Object.keys(reparsed.custom).length > 0 ? { custom: reparsed.custom } : {}),
    })
    assert.equal(again, once, '文本级幂等（无逐次漂移）')
  })
})

describe('serializeAgentClass / 路径守卫（红线）', () => {
  test('panel 类永不序列化（系统机制与用户基因分界）', () => {
    const panel: AgentClass = { ...full, panel: true }
    assert.throws(() => serializeAgentClass(panel), /panel 类.*永不回写/)
  })

  test('custom 与 frontmatter 已知键冲突 = 歧义，拒绝落盘', () => {
    const bad: AgentClass = { ...full, custom: { description: 'collision' } }
    assert.throws(() => serializeAgentClass(bad), /已知键冲突/)
  })

  test('custom 中 undefined 值剔除（保持往返干净）', () => {
    const cls: AgentClass = { ...full, custom: { a: 1, b: undefined } }
    const parsed = parseAgentFile(serializeAgentClass(cls), 'reviewer')
    assert.deepEqual(parsed.custom, { a: 1 })
  })

  test('类名字符集守卫（拒路径穿越；模型可控输入参与文件路径）', () => {
    assert.equal(agentFileName('ok-1.2_a'), 'ok-1.2_a.md')
    assert.throws(() => agentFileName('../evil'), /不可作为文件名/)
    assert.throws(() => agentFileName('a/b'), /不可作为文件名/)
    assert.throws(() => agentFileName(''), /不可作为文件名/)
    assert.equal(agentFileOf('/p/.stem/agent/', 'x'), '/p/.stem/agent/x.md', '目录尾斜杠归一')
  })
})
