// ============================================================
// core/kernel/LineageTree.test.ts —— 族谱树单测
//
// 关系：InstanceManager（事实源）持有 parentId；
// LineageTree 是无状态查询视图（getChildren/ancestors/descendants/isAncestorOf）。
// 销毁权：仅祖先（含 user0 根）可销毁；有活跃子默认拒绝，recursive 级联。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DefaultTemplateRegistry } from './TemplateRegistry'
import { DefaultInstanceManager } from './InstanceManager'
import { DefaultLineageTree } from './LineageTree'
import type { AgentClass, AgentID } from './types'
import { makeAgentClassID, makeAgentID } from './types'
import { toolAccessToRules } from '../tools'

const cls: AgentClass = {
  name: makeAgentClassID('worker'),
  description: 'worker agent',
  systemPrompt: 'work',
  tools: { read: 'allow', write: 'deny' },
}

/** 构造 manager + lineage，并注册 user0 根。 */
async function makeTree() {
  const registry = new DefaultTemplateRegistry([cls])
  const manager = new DefaultInstanceManager(registry)
  await manager.registerMetaAgent({ id: makeAgentID('user0') })
  const lineage = new DefaultLineageTree({
    getInstance: (id) => manager.getSync(id),
    getAllInstances: () => manager.listAllSync(),
    accessLayerOf: (instance) => {
      const template = registry.getSync(instance.classRef)
      return template ? toolAccessToRules(template.tools) : undefined
    },
  })
  const spaceId = 'space-1' as never
  return { manager, lineage, spaceId }
}

describe('LineageTree（无状态查询视图）', () => {
  test('祖先链：user0 根无祖先；子 agent 链到根', async () => {
    const { manager, lineage, spaceId } = await makeTree()
    const root = await manager.instantiate({ className: cls.name, parentId: makeAgentID('user0'), userPrompt: 'hi', spaceId, agentId: 'root1' })
    const child = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId, agentId: 'child1' })
    const grand = await manager.instantiate({ className: cls.name, parentId: child.id, userPrompt: 'hi', spaceId, agentId: 'grand1' })

    assert.deepEqual(lineage.getAncestors(makeAgentID('user0')), [])
    assert.deepEqual(lineage.getAncestors(root.id), ['user0'])
    assert.deepEqual(lineage.getAncestors(child.id), [root.id, 'user0'])
    assert.deepEqual(lineage.getAncestors(grand.id), [child.id, root.id, 'user0'])
  })

  test('children / descendants：BFS 子树', async () => {
    const { manager, lineage, spaceId } = await makeTree()
    const root = await manager.instantiate({ className: cls.name, parentId: makeAgentID('user0'), userPrompt: 'hi', spaceId, agentId: 'root2' })
    const c1 = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId, agentId: 'c1' })
    const c2 = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId, agentId: 'c2' })
    await manager.instantiate({ className: cls.name, parentId: c1.id, userPrompt: 'hi', spaceId, agentId: 'c1a' })

    assert.deepEqual([...lineage.getChildren(root.id)].sort(), ['c1', 'c2'])
    assert.deepEqual([...lineage.getDescendants(root.id)].sort(), ['c1', 'c1a', 'c2'])
    assert.deepEqual(lineage.getDescendants(c2.id), [])
    // 兄弟不属于彼此后代。
    assert.ok(!lineage.getDescendants(c1.id).includes(c2.id))
  })

  test('isAncestorOf：销毁权判定（user0 根恒 true）', async () => {
    const { manager, lineage, spaceId } = await makeTree()
    const root = await manager.instantiate({ className: cls.name, parentId: makeAgentID('user0'), userPrompt: 'hi', spaceId, agentId: 'root3' })
    const child = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId, agentId: 'child3' })

    assert.equal(lineage.isAncestorOf(makeAgentID('user0'), child.id), true)
    assert.equal(lineage.isAncestorOf(root.id, child.id), true)
    assert.equal(lineage.isAncestorOf(child.id, root.id), false)
    assert.equal(lineage.isAncestorOf(child.id, child.id), false)
  })

  test('resolveAccessLayers：祖先链逐层收集访问规则（父在前）', async () => {
    const { manager, lineage, spaceId } = await makeTree()
    const root = await manager.instantiate({ className: cls.name, parentId: makeAgentID('user0'), userPrompt: 'hi', spaceId, agentId: 'root4' })
    const child = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId, agentId: 'child4' })

    const layers = lineage.resolveAccessLayers(child.id)
    // 祖先链 [root4, user0]：user0 无 AgentClass（元 agent）→ accessLayerOf 返回
    // undefined 被过滤，因此有效层数为 1（root4 的 read:allow / write:deny）。
    assert.equal(layers.length, 1)
    assert.deepEqual(
      layers.map((l) => l.map((r) => [r.key, r.action])),
      [[['read', 'allow'], ['write', 'deny']]],
    )
  })

  test('销毁权：非祖先调用者被拒；有活跃子默认拒绝；recursive 级联', async () => {
    const { manager, spaceId } = await makeTree()
    const root = await manager.instantiate({ className: cls.name, parentId: makeAgentID('user0'), userPrompt: 'hi', spaceId, agentId: 'root5' })
    const child = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId, agentId: 'child5' })

    // 非祖先（另一个游离 agent）销毁 → denied。
    const outsider = await manager.instantiate({ className: cls.name, parentId: makeAgentID('user0'), userPrompt: 'hi', spaceId, agentId: 'out5' })
    await assert.rejects(
      () => manager.terminate(child.id, { by: outsider.id }),
      (e: unknown) => (e as { kind: string }).kind === 'agent_terminate_denied',
    )

    // 根销毁子 → 允许。
    await manager.terminate(child.id, { by: makeAgentID('user0') })

    // 有活跃子默认拒绝。
    const child2 = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId, agentId: 'child5b' })
    await assert.rejects(
      () => manager.terminate(root.id, { by: makeAgentID('user0') }),
      (e: unknown) => (e as { kind: string }).kind === 'agent_has_children',
    )

    // recursive 级联销毁整棵子树。
    const grand = await manager.instantiate({ className: cls.name, parentId: child2.id, userPrompt: 'hi', spaceId, agentId: 'grand5' })
    await manager.terminate(root.id, { by: makeAgentID('user0'), recursive: true })
    for (const id of [root.id, child2.id, grand.id] as AgentID[]) {
      await assert.rejects(() => manager.get(id), (e: unknown) => (e as { kind: string }).kind === 'agent_not_found')
    }
  })

  test('元 agent（user0）不可销毁', async () => {
    const { manager } = await makeTree()
    await assert.rejects(
      () => manager.terminate(makeAgentID('user0'), { by: makeAgentID('user0') }),
      (e: unknown) => (e as { kind: string }).kind === 'agent_terminate_denied',
    )
  })

  test('父不存在 → agent_conflict', async () => {
    const { manager, spaceId } = await makeTree()
    await assert.rejects(
      () => manager.instantiate({ className: cls.name, parentId: makeAgentID('ghost'), userPrompt: 'hi', spaceId }),
      (e: unknown) => (e as { kind: string }).kind === 'agent_conflict',
    )
  })
})
