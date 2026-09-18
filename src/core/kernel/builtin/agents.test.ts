// ============================================================
// core/kernel/builtin/agents.test.ts —— 内置类表与 user 类装配
//
// 类形态统一后的唯一定义域：buildUserClass 全字段消费、整表替换
// 语义、内置表形状（user/assistant）、根出生称呼配置链。
// （原 userClass.test.ts 迁入，断言保真。）
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeGateway, textEvents } from '../../gateway'
import { buildUserClass, BUILTIN_AGENT_CLASSES, USER_DEFAULT, ASSISTANT } from './agents'
import { ROOT_ID, USER_CLASS_ID, makeAgentID } from '../types'

import { createKernelHarness } from '../../../../test/support/kernelHarness'

describe('buildUserClass（根的类配置）', () => {
  test('缺省档 = 无注入清单（DEFAULT_USER_TOOLS 退役；根义务由 boot 律与模板实值分管）', () => {
    const cls = buildUserClass()
    assert.equal(cls.name, USER_CLASS_ID)
    assert.equal(cls.tools, undefined, '代码零缺省清单——缺省 = 完整继承注册声明表')
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
    assert.equal(cls.tools, undefined, 'tools 缺省 = 不设限（完整继承出生表，DEFAULT_USER_TOOLS 已退役）')
  })

  test('tools 给出 = 根收敛清单（键即白名单，用户自担 access_reply 义务）', () => {
    const cls = buildUserClass({ tools: { read: 'allow' } })
    assert.deepEqual(cls.tools, { read: 'allow' })
    assert.equal(cls.tools!.access_reply, undefined, '给定即全部（键即白名单）；access_reply 缺位由 boot 校验律拒启')
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

describe('根出生称呼（config.user.name → 实例行）', () => {
  test('配置给名 = 根实例 name 非缺省；缺省 = user', async () => {
    const gateway = new FakeGateway(() => textEvents('ok'))
    const named = await createKernelHarness(gateway, {
      userClass: { name: '管家', model: { provider: 'fake', id: 'home-model' } } ,
    })
    assert.equal(named.kernel.instances.getSync(ROOT_ID)?.name, '管家')
    const plain = await createKernelHarness(new FakeGateway(() => textEvents('ok')))
    assert.equal(plain.kernel.instances.getSync(ROOT_ID)?.name, 'user')
  })
})
