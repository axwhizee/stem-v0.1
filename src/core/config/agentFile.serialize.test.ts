// ============================================================
// core/config/agentFile.serialize.test.ts —— 类序列化器单测（往返律）
//
// 核心契约：parse(serialize(cls), name) ≡ normalize(cls)。
// 类名字符集守卫。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { makeAgentClassID, type AgentClass } from '../kernel'
import { parseAgentFile } from './agentFile'
import { serializeAgentClass, agentFileName, agentFileOf } from './agentFile'

const full: AgentClass = {
  name: makeAgentClassID('reviewer'),
  description: '代码审查专家：读 diff、给结论。',
  systemPrompt: '你是审查者。\n输出三点结论：\n- 正确性\n- 风险\n- 建议',
  tools: { read: 'allow', edit: 'ask', bash: 'deny', skill: 'ignore' },
  sendCountdown: 1500,
  contextStrategy: 'classic',
  model: { provider: 'opencode-go', id: 'deepseek-v4-flash' },
  temperature: 0.2,
  effort: 'high',
}

describe('serializeAgentClass（往返律：parse ∘ serialize ≡ id）', () => {
  test('全字段类往返无损（含四态 tools / temperature / effort）', () => {
    const text = serializeAgentClass(full)
    const parsed = parseAgentFile(text, 'reviewer')
    assert.equal(parsed.name, 'reviewer')
    assert.equal(parsed.description, full.description)
    assert.deepEqual(parsed.toolAccess, full.tools, '四态工具清单原样往返')
    assert.equal(parsed.sendCountdown, 1500)
    assert.equal(parsed.contextStrategy, 'classic')
    assert.deepEqual(parsed.model, { provider: 'opencode-go', id: 'deepseek-v4-flash' })
    assert.equal(parsed.temperature, 0.2)
    assert.equal(parsed.effort, 'high')
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
      ...(reparsed.temperature !== undefined ? { temperature: reparsed.temperature } : {}),
      ...(reparsed.effort !== undefined ? { effort: reparsed.effort } : {}),
    })
    assert.equal(again, once, '文本级幂等（无逐次漂移）')
  })
})

describe('serializeAgentClass / 路径守卫', () => {
  test('类名字符集守卫（拒路径穿越；模型可控输入参与文件路径）', () => {
    assert.equal(agentFileName('ok-1.2_a'), 'ok-1.2_a.md')
    assert.throws(() => agentFileName('../evil'), /不可作为文件名/)
    assert.throws(() => agentFileName('a/b'), /不可作为文件名/)
    assert.throws(() => agentFileName(''), /不可作为文件名/)
    assert.equal(agentFileOf('/p/.stem/agent/', 'x'), '/p/.stem/agent/x.md', '目录尾斜杠归一')
  })
})
