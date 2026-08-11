// ============================================================
// core/kernel/AgentInstanceManager.test.ts
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DefaultAgentTemplateRegistry } from './AgentTemplateRegistry'
import { DefaultAgentInstanceManager } from './AgentInstanceManager'
import { DefaultAgentSpaceManager } from './AgentSpaceManager'
import type { AgentClass } from './types'
import { makeAgentClassID } from './types'

const cls: AgentClass = {
  id: makeAgentClassID('worker'),
  name: 'Worker',
  description: 'worker agent',
  systemPrompt: 'work',
  tools: [],
  permission: 'normal',
  memoryScope: [],
}

async function makeManager() {
  const registry = new DefaultAgentTemplateRegistry([cls])
  const manager = new DefaultAgentInstanceManager(registry)
  const space = await new DefaultAgentSpaceManager().getOrCreate('/proj')
  return { manager, spaceId: space.id }
}

describe('DefaultAgentInstanceManager', () => {
  test('instantiate + get + listBySpace + terminate', async () => {
    const { manager, spaceId } = await makeManager()
    const a1 = await manager.instantiate({ classId: cls.id, creatorId: 'user0', userPrompt: 'hi', spaceId, displayName: '甲' })
    const a2 = await manager.instantiate({ classId: cls.id, creatorId: 'user0', userPrompt: 'hi', spaceId })

    assert.equal(a1.displayName, '甲')
    assert.equal(a2.displayName, 'Worker')
    assert.equal(a1.createdBy, 'user')
    assert.equal(a1.creatorId, 'user0')
    assert.equal(a1.userPrompt, 'hi')
    assert.equal(a1.status, 'idle')

    assert.equal((await manager.listBySpace(spaceId)).length, 2)
    assert.equal((await manager.get(a1.id)).classRef, cls.id)

    await manager.terminate(a1.id)
    assert.equal((await manager.listBySpace(spaceId)).length, 1)
    await assert.rejects(() => manager.get(a1.id), (e: unknown) => (e as { kind: string }).kind === 'agent_not_found')
  })

  test('agent 创建：creatorId 为创建者 id，createdBy 为 agent', async () => {
    const { manager, spaceId } = await makeManager()
    const a = await manager.instantiate({ classId: cls.id, creatorId: 'agent-9', userPrompt: 'hi', spaceId })
    assert.equal(a.createdBy, 'agent-9')
    assert.equal(a.creatorId, 'agent-9')
  })

  test('显式 id 冲突 → agent_conflict', async () => {
    const { manager, spaceId } = await makeManager()
    await manager.instantiate({ classId: cls.id, creatorId: 'user0', userPrompt: 'hi', spaceId, id: 'abcd' })
    await assert.rejects(
      () => manager.instantiate({ classId: cls.id, creatorId: 'user0', userPrompt: 'hi', spaceId, id: 'abcd' }),
      (e: unknown) => (e as { kind: string }).kind === 'agent_conflict',
    )
  })

  test('userPrompt 必填 → agent_conflict', async () => {
    const { manager, spaceId } = await makeManager()
    await assert.rejects(
      () => manager.instantiate({ classId: cls.id, creatorId: 'user0', userPrompt: '', spaceId }),
      (e: unknown) => (e as { kind: string }).kind === 'agent_conflict',
    )
  })

  test('随机 id 为 4 位且唯一', async () => {
    const { manager, spaceId } = await makeManager()
    const a = await manager.instantiate({ classId: cls.id, creatorId: 'user0', userPrompt: 'hi', spaceId })
    assert.match(a.id, /^[0-9a-z]{4}$/)
  })

  test('无效 classRef → template_not_found', async () => {
    const { manager, spaceId } = await makeManager()
    await assert.rejects(
      () => manager.instantiate({ classId: makeAgentClassID('missing'), creatorId: 'user0', userPrompt: 'hi', spaceId }),
      (e: unknown) => (e as { kind: string }).kind === 'template_not_found',
    )
  })

  test('updateStatus / takeover', async () => {
    const { manager, spaceId } = await makeManager()
    const a = await manager.instantiate({ classId: cls.id, creatorId: 'user0', userPrompt: 'hi', spaceId })
    await manager.updateStatus(a.id, 'thinking')
    assert.equal((await manager.get(a.id)).status, 'thinking')

    await manager.takeover(a.id, { displayName: '改名后' })
    assert.equal((await manager.get(a.id)).displayName, '改名后')
  })
})
