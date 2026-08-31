// ============================================================
// core/kernel/userClass.test.ts —— 内置 user 类（config.user 全对象消费）
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createUserClass, DEFAULT_USER_TOOLS, USER_CLASS_ID } from './userClass'

describe('createUserClass（user0 内嵌 agent 类配置）', () => {
  test('缺省 = 内置默认表：根答复义务在场（B3 死锁修复回归锚点）', () => {
    const cls = createUserClass()
    assert.equal(cls.name, USER_CLASS_ID)
    assert.equal(cls.tools.access_reply, 'allow', 'access_reply 必须在默认表中——缺失 = ask 消息化死锁')
    assert.equal(cls.tools.agent_instantiate, 'allow')
    assert.equal(cls.tools.agent_terminate, 'ask', '高危面默认 ask')
    assert.equal(cls.tools.read, undefined, '宿主文件工具默认不进根清单（缺席≠否决，不锁子孙）')
    assert.equal(cls.sendCountdown, 0)
    assert.equal(cls.systemPrompt, '')
  })

  test('config.user 全字段消费：人格/策略/模型声明式可配', () => {
    const cls = createUserClass({
      description: '温和的根',
      systemPrompt: '你是这个系统的原点。',
      contextStrategy: 'classic',
      model: { provider: 'opencode-go', id: 'deepseek-v4-flash' },
      sendCountdown: 500,
    })
    assert.equal(cls.description, '温和的根')
    assert.equal(cls.systemPrompt, '你是这个系统的原点。')
    assert.equal(cls.contextStrategy, 'classic')
    assert.deepEqual(cls.model, { provider: 'opencode-go', id: 'deepseek-v4-flash' })
    assert.equal(cls.sendCountdown, 500)
    assert.equal(cls.tools, DEFAULT_USER_TOOLS, 'permission 缺省仍走默认表')
  })

  test('permission 给出 = 整表替换（用户自担根义务配置）', () => {
    const cls = createUserClass({ permission: { read: 'allow' } })
    assert.deepEqual(cls.tools, { read: 'allow' })
    assert.equal(cls.tools.access_reply, undefined, '整表替换语义：默认表不叠加')
  })
})
