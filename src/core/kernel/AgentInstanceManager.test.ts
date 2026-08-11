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

describe('DefaultAgentInstanceManager', () => {
  test('instantiate + get + listBySpace + terminate', async () => {
    const registry = new DefaultAgentTemplateRegistry([cls])
    const manager = new DefaultAgentInstanceManager(registry)
    const spaces = new DefaultAgentSpaceManager()
    const space = await spaces.getOrCreate('/proj')

    const a1 = await manager.instantiate(cls.id, { spaceId: space.id, displayName: '甲' })
    const a2 = await manager.instantiate(cls.id, { spaceId: space.id })

    assert.equal(a1.displayName, '甲')
    assert.equal(a2.displayName, 'worker') // 缺省用 classId
    assert.equal(a1.createdBy, 'user')
    assert.equal(a1.status, 'idle')

    assert.equal((await manager.listBySpace(space.id)).length, 2)
    assert.equal((await manager.get(a1.id)).classRef, cls.id)

    await manager.terminate(a1.id)
    assert.equal((await manager.listBySpace(space.id)).length, 1)
    await assert.rejects(() => manager.get(a1.id), (e: unknown) => (e as { kind: string }).kind === 'agent_not_found')
  })

  test('无效 classRef → template_not_found', async () => {
    const registry = new DefaultAgentTemplateRegistry()
    const manager = new DefaultAgentInstanceManager(registry)
    await assert.rejects(
      () => manager.instantiate(makeAgentClassID('missing'), { spaceId: 'space-1' as never }),
      (e: unknown) => (e as { kind: string }).kind === 'template_not_found',
    )
  })

  test('updateStatus / takeover', async () => {
    const registry = new DefaultAgentTemplateRegistry([cls])
    const manager = new DefaultAgentInstanceManager(registry)
    const space = await new DefaultAgentSpaceManager().getOrCreate('/proj')

    const agent = await manager.instantiate(cls.id, { spaceId: space.id })
    await manager.updateStatus(agent.id, 'running')
    assert.equal((await manager.get(agent.id)).status, 'running')

    await manager.takeover(agent.id, { displayName: '改名后' })
    assert.equal((await manager.get(agent.id)).displayName, '改名后')
  })
})
