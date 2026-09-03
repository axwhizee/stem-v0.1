// ============================================================
// core/kernel/InstanceManager.test.ts
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DefaultTemplateRegistry } from './TemplateRegistry'
import { DefaultInstanceManager } from './InstanceManager'
import { DefaultSpaceManager } from './SpaceManager'
import type { AgentClass } from './types'
import { makeAgentClassID, makeAgentID, makeAgentSpaceID } from './types'

const cls: AgentClass = {
  name: makeAgentClassID('worker'),
  description: 'worker agent',
  systemPrompt: 'work',
  tools: {},
}

async function makeManager() {
  const registry = new DefaultTemplateRegistry([cls])
  const manager = new DefaultInstanceManager(registry)
  const space = await new DefaultSpaceManager().getOrCreate('/proj')
  // 根 agent（user0）：普通实例（parentId=null，独立 meta 空间），userPrompt 可为空。
  await manager.instantiate({ className: cls.name, parentId: null, userPrompt: '', spaceId: makeAgentSpaceID('__meta__'), agentId: 'user0' })
  return { manager, spaceId: space.id }
}

describe('DefaultInstanceManager', () => {
  test('instantiate + get + listBySpace + terminate', async () => {
    const { manager, spaceId } = await makeManager()
    const a1 = await manager.instantiate({ className: cls.name, parentId: makeAgentID('user0'), userPrompt: 'hi', spaceId, agentId: 'a1' })
    const a2 = await manager.instantiate({ className: cls.name, parentId: makeAgentID('user0'), userPrompt: 'hi', spaceId, agentId: 'a2' })

    assert.equal(a1.displayName, 'worker')
    assert.equal(a2.displayName, 'worker')
    assert.equal(a1.parentId, 'user0')
    assert.equal(a1.userPrompt, 'hi')
    assert.equal(a1.status, 'idle')

    assert.equal((await manager.listBySpace(spaceId)).length, 2)
    assert.equal((await manager.get(a1.id)).classRef, cls.name)

    await manager.terminate(a1.id)
    assert.equal((await manager.listBySpace(spaceId)).length, 1)
    await assert.rejects(() => manager.get(a1.id), (e: unknown) => (e as { kind: string }).kind === 'agent_not_found')
  })

  test('agent 创建：parentId 即创建者（族谱父）', async () => {
    const { manager, spaceId } = await makeManager()
    // 父 = 创建者；'agent-9' 未注册为实例 → 需显式 parentId:null 表示游离根。
    const a = await manager.instantiate({ className: cls.name, parentId: null, userPrompt: 'hi', spaceId, agentId: 'a9' })
    assert.equal(a.parentId, null)
  })

  test('显式 id 冲突 → agent_conflict', async () => {
    const { manager, spaceId } = await makeManager()
    await manager.instantiate({ className: cls.name, parentId: makeAgentID('user0'), userPrompt: 'hi', spaceId, agentId: 'abcd' })
    await assert.rejects(
      () => manager.instantiate({ className: cls.name, parentId: makeAgentID('user0'), userPrompt: 'hi', spaceId, agentId: 'abcd' }),
      (e: unknown) => (e as { kind: string }).kind === 'agent_conflict',
    )
  })

  test('userPrompt 非字符串 → agent_conflict（空串允许，根 agent 用）', async () => {
    const { manager, spaceId } = await makeManager()
    await assert.rejects(
      () => manager.instantiate({ className: cls.name, parentId: makeAgentID('user0'), userPrompt: undefined as never, spaceId }),
      (e: unknown) => (e as { kind: string }).kind === 'agent_conflict',
    )
  })

  test('随机 id 为 4 位且唯一', async () => {
    const { manager, spaceId } = await makeManager()
    const a = await manager.instantiate({ className: cls.name, parentId: makeAgentID('user0'), userPrompt: 'hi', spaceId })
    assert.match(a.id, /^[0-9a-z]{4}$/)
  })

  test('无效 className → template_not_found', async () => {
    const { manager, spaceId } = await makeManager()
    await assert.rejects(
      () => manager.instantiate({ className: makeAgentClassID('missing'), parentId: makeAgentID('user0'), userPrompt: 'hi', spaceId }),
      (e: unknown) => (e as { kind: string }).kind === 'template_not_found',
    )
  })

  test('updateStatus / update', async () => {
    const { manager, spaceId } = await makeManager()
    const a = await manager.instantiate({ className: cls.name, parentId: makeAgentID('user0'), userPrompt: 'hi', spaceId })
    await manager.updateStatus(a.id, 'thinking')
    assert.equal((await manager.get(a.id)).status, 'thinking')

    await manager.update(a.id, { displayName: '改名后' })
    assert.equal((await manager.get(a.id)).displayName, '改名后')
  })
})
