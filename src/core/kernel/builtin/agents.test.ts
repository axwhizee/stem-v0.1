// ============================================================
// core/kernel/builtin/agents.test.ts —— 内置类表与 user 类装配
//
// S9 类形态统一后的唯一定义域：buildUserClass 全字段消费、整表替换
// 语义、内置表形状（user/assistant）、user0 出生显示名配置链。
// （原 userClass.test.ts 迁入，断言保真。）
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeGateway, textEvents } from '../../gateway'
import { buildUserClass, BUILTIN_AGENT_CLASSES, DEFAULT_USER_TOOLS, USER_DEFAULT, ASSISTANT } from './agents'
import { USER_CLASS_ID, makeAgentID } from '../types'
import { USER_ID } from '../Kernel'
import { createKernelHarness } from '../../../../test/support/kernelHarness'

describe('buildUserClass（user0 内嵌 agent 类配置）', () => {
  test('缺省 = 内置默认表：根答复义务在场（B3 死锁修复回归锚点）', () => {
    const cls = buildUserClass()
    assert.equal(cls.name, USER_CLASS_ID)
    assert.equal(cls.tools!.access_reply, 'allow', 'access_reply 必须在默认表中——缺失 = ask 消息化死锁')
    assert.equal(cls.tools!.agent_instantiate, 'allow')
    assert.equal(cls.tools!.agent_terminate, 'ask', '高危面默认 ask')
    assert.equal(cls.tools!.bash, 'allow', 'bash 默认 allow——高频工具不走 ask（治理靠超时/截断/提示词，S4.1）')
    assert.equal(cls.tools!.read, undefined, '宿主文件工具默认不进根清单（缺席≠否决，不锁子孙）')
    assert.equal(cls.tools!.cortex_add_note, 'allow', 'S8 记忆笔记面常开')
    assert.equal(cls.tools!.cortex_set_ltm, undefined, 'set 工具不列根表 = 全树匿名 deny（dream 专属）')
    assert.equal(cls.sendCountdown, 0)
    assert.equal(cls.systemPrompt, '')
  })

  test('config.user 全字段消费：人格/策略/模型声明式可配', () => {
    const cls = buildUserClass({
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
    assert.equal(cls.tools, DEFAULT_USER_TOOLS, 'user.tools 缺省仍走默认表')
  })

  test('tools 给出 = 整表替换（用户自担根义务配置）', () => {
    const cls = buildUserClass({ tools: { read: 'allow' } })
    assert.deepEqual(cls.tools, { read: 'allow' })
    assert.equal(cls.tools!.access_reply, undefined, '整表替换语义：默认表不叠加')
  })
})

describe('内置类表（类形态统一的静态面）', () => {
  test('BUILTIN_AGENT_CLASSES 形状：user 默认档 + assistant 白纸，必填件齐', () => {
    assert.deepEqual(BUILTIN_AGENT_CLASSES.map((c) => c.name), [USER_DEFAULT.name, ASSISTANT.name])
    for (const cls of BUILTIN_AGENT_CLASSES) {
      assert.ok(cls.description.length > 0)
      assert.equal(typeof cls.systemPrompt, 'string')
    }
    assert.equal(ASSISTANT.tools, undefined, 'assistant 白纸 = tools 不设（完整继承父档案，族谱台账语义）')
    assert.equal(ASSISTANT.contextStrategy, undefined, '缺省策略 = 注册表 default（classic）')
  })
})

describe('user0 出生显示名（config.user.displayName → 实例行）', () => {
  test('配置给名 = 根实例 displayName 非缺省；缺省 = User', async () => {
    const gateway = new FakeGateway(() => textEvents('ok'))
    const named = await createKernelHarness(gateway, {
      userClass: { displayName: '管家', model: { provider: 'fake', id: 'home-model' } } as never,
    })
    assert.equal(named.kernel.instances.getSync(makeAgentID(USER_ID))?.displayName, '管家')
    const plain = await createKernelHarness(new FakeGateway(() => textEvents('ok')))
    assert.equal(plain.kernel.instances.getSync(makeAgentID(USER_ID))?.displayName, 'User')
  })
})
