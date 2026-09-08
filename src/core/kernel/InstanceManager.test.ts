// ============================================================
// core/kernel/InstanceManager.test.ts —— 身份注册表（B1/B2/B3 定律的 CI 形态）
//
// 覆盖审计律：出生路径 id（序号永不回收/墓碑占位）、name 全局唯一
// （出生撞名拒/改名撞名拒）、寻址三形态往返（name / name#id / 精确 id /
// 唯一前缀 / 歧义前缀）。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DefaultTemplateRegistry } from './TemplateRegistry'
import { DefaultInstanceManager } from './InstanceManager'
import { DefaultSpaceManager } from './SpaceManager'
import type { AgentClass } from './types'
import { AGENT_ID_PATTERN, makeAgentClassID, makeAgentID, makeAgentSpaceID, parentIdOf, ROOT_ID } from './types'

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
  // 根 = user 类普通实例（id 纯推导 `0`，name 缺省派生 `worker-1` 属此类形态——
  // 真实根称呼由 kernel registerRootAgent 统一给 'user'）。
  const root = await manager.instantiate({ className: cls.name, parentId: null, userPrompt: '', spaceId: makeAgentSpaceID('__meta__') })
  return { manager, root, spaceId: space.id }
}

describe('出生路径 id（B1）', () => {
  test('根 = 0；子 = <父id>-<序号>，代际/父 = 纯推导', async () => {
    const { manager, root, spaceId } = await makeManager()
    assert.equal(root.id, ROOT_ID)
    assert.match(root.id, AGENT_ID_PATTERN)
    assert.equal(parentIdOf(root.id), null)
    const c1 = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId })
    const c2 = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId })
    const g = await manager.instantiate({ className: cls.name, parentId: c2.id, userPrompt: 'hi', spaceId })
    assert.equal(c1.id, '0-1')
    assert.equal(c2.id, '0-2')
    assert.equal(g.id, '0-2-1')
    assert.equal(parentIdOf(g.id), '0-2')
  })

  test('序号永不回收：terminate 后下一个出生跳号（地址复用=历史信件指错实体）', async () => {
    const { manager, root, spaceId } = await makeManager()
    const a = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId })
    const b = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId })
    await manager.terminate(a.id)
    const c = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId })
    assert.equal(a.id, '0-1')
    assert.equal(b.id, '0-2')
    assert.equal(c.id, '0-3', '被销毁的 0-1 不被复用')
  })

  test('restore 扫描含墓碑行立计数器地板（重启不复用历史地址）', async () => {
    const { manager } = await makeManager()
    const spaceId = makeAgentSpaceID('s')
    manager.restore({
      id: makeAgentID('0-7'), classRef: cls.name, parentId: ROOT_ID, name: 'worker-8',
      spaceId, status: 'terminated', turnCount: 0, totalCost: 0, userPrompt: '',
    })
    const next = await manager.instantiate({ className: cls.name, parentId: ROOT_ID, userPrompt: 'hi', spaceId })
    assert.equal(next.id, '0-8', '墓碑 0-7 占位在先')
    assert.equal(next.name, 'worker-9', '派生名同样避占用')
  })

  test('第二个根 → id 冲突（一进程一根一空间）', async () => {
    const { manager, spaceId } = await makeManager()
    await assert.rejects(
      () => manager.instantiate({ className: cls.name, parentId: null, userPrompt: '', spaceId }),
      (e: unknown) => (e as { kind: string }).kind === 'agent_conflict',
    )
  })
})

describe('name 全局唯一（B2）', () => {
  test('缺省确定性派生 `类名-N`（无随机、可复现）', async () => {
    const { manager, root, spaceId } = await makeManager()
    const a = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId })
    const b = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId })
    assert.equal(a.name, 'worker-2')
    assert.equal(b.name, 'worker-3')
  })

  test('出生显式撞名 → agent_name_conflict（绝不自动后缀）', async () => {
    const { manager, root, spaceId } = await makeManager()
    await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId, name: 'alice' })
    await assert.rejects(
      () => manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId, name: 'alice' }),
      (e: unknown) => (e as { kind: string }).kind === 'agent_name_conflict',
    )
  })

  test('改名撞名拒；旧名释放可复用', async () => {
    const { manager, root, spaceId } = await makeManager()
    const a = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId })
    const b = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId, name: 'bob' })
    await assert.rejects(
      () => manager.update(b.id, { name: a.name }),
      (e: unknown) => (e as { kind: string }).kind === 'agent_name_conflict',
    )
    await manager.update(b.id, { name: 'robert' })
    assert.equal((await manager.get(b.id)).name, 'robert')
    assert.equal((await manager.get(b.id)).id, b.id, 'id 是出生路径，改名不动地址')
  })

  test('销毁者称呼仍占位（墓碑在册）', async () => {
    const { manager, root, spaceId } = await makeManager()
    const a = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId, name: 'ghost' })
    await manager.terminate(a.id)
    await assert.rejects(
      () => manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId, name: 'ghost' }),
      (e: unknown) => (e as { kind: string }).kind === 'agent_name_conflict',
    )
  })

  test('装载唯一性校验（文件真相被手改的 DB 重复名 = boot 硬错料）', async () => {
    const { manager } = await makeManager()
    const spaceId = makeAgentSpaceID('s')
    const dup: AgentInstanceLike[] = [
      { id: '0-1', name: 'x', parentId: ROOT_ID, status: 'idle' },
      { id: '0-2', name: 'x', parentId: ROOT_ID, status: 'idle' },
    ]
    assert.deepEqual(
      manager.assertNamesUnique(dup as never),
      ['x'],
    )
  })
})

describe('寻址三形态（B3）', () => {
  async function seeded() {
    const { manager, root, spaceId } = await makeManager()
    const a = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId, name: 'alice' })
    const b = await manager.instantiate({ className: cls.name, parentId: a.id, userPrompt: 'hi', spaceId, name: 'bob' })
    return { manager, root, a, b }
  }

  test('name / name#id / 精确 id / 唯一 id 前缀 → 同一实例（往返）', async () => {
    const { manager, b } = await seeded()
    for (const ref of ['bob', 'bob#0-1-1', '0-1-1', '0-1-']) {
      const r = manager.resolve(ref)
      assert.deepEqual(r, { found: b.id }, `ref=${ref}`)
    }
    // 非唯一前缀不误伤：'0-1' 命中 alice 精确 id（精确优先于前缀）。
    assert.deepEqual(manager.resolve('0-1'), { found: '0-1' })
  })

  test('歧义前缀 → ambiguous 带候选（name#id 形）', async () => {
    const { manager, a } = await seeded()
    const c = await manager.instantiate({ className: cls.name, parentId: a.id, userPrompt: 'hi', spaceId: a.spaceId, name: 'carol' })
    const r = manager.resolve('0-1-')
    assert.ok('ambiguous' in r)
    assert.deepEqual([...r.ambiguous].sort(), ['bob#0-1-1', `carol#${c.id}`].sort())
  })

  test('name#id 不吻合 → 不命中（id 在场但 name 漂移不误配）', async () => {
    const { manager, b } = await seeded()
    assert.deepEqual(manager.resolve('mallory#0-1-1'), { notFound: true })
  })

  test('销毁后不可寻址（墓碑不被 name 命中）', async () => {
    const { manager, a } = await seeded()
    await manager.terminate(a.id, { by: ROOT_ID, recursive: true })
    assert.deepEqual(manager.resolve('alice'), { notFound: true })
  })

  test('displayOf = name#id 全名；未知 id 回落裸 id', async () => {
    const { manager, a } = await seeded()
    assert.equal(manager.displayOf(a.id), 'alice#0-1')
    assert.equal(manager.displayOf('9-9'), '9-9')
  })
})

describe('基础行为', () => {
  test('instantiate + get + listBySpace + terminate', async () => {
    const { manager, root, spaceId } = await makeManager()
    const a1 = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId })
    const a2 = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId })
    assert.equal(a1.name, 'worker-2')
    assert.equal(a1.parentId, root.id)
    assert.equal(a1.userPrompt, 'hi')
    assert.equal(a1.status, 'idle')
    assert.equal((await manager.listBySpace(spaceId)).length, 2)
    assert.equal((await manager.get(a1.id)).classRef, cls.name)
    await manager.terminate(a1.id)
    assert.equal((await manager.listBySpace(spaceId)).length, 1)
    await assert.rejects(() => manager.get(a1.id), (e: unknown) => (e as { kind: string }).kind === 'agent_not_found')
  })

  test('by 缺省 = 根（销毁权天然全树祖先）', async () => {
    const { manager, root, spaceId } = await makeManager()
    const a = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId })
    await manager.terminate(a.id) // 不传 by → ROOT_ID 路径可达
    assert.equal((await manager.listBySpace(spaceId)).length, 0)
  })

  test('userPrompt 非字符串 → agent_conflict（空串允许，根实例用）', async () => {
    const { manager, root, spaceId } = await makeManager()
    await assert.rejects(
      () => manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: undefined as never, spaceId }),
      (e: unknown) => (e as { kind: string }).kind === 'agent_conflict',
    )
  })

  test('无效 className → template_not_found', async () => {
    const { manager, root, spaceId } = await makeManager()
    await assert.rejects(
      () => manager.instantiate({ className: makeAgentClassID('missing'), parentId: root.id, userPrompt: 'hi', spaceId }),
      (e: unknown) => (e as { kind: string }).kind === 'template_not_found',
    )
  })

  test('updateStatus / update（name/toolOverride/model 三件）', async () => {
    const { manager, root, spaceId } = await makeManager()
    const a = await manager.instantiate({ className: cls.name, parentId: root.id, userPrompt: 'hi', spaceId })
    await manager.updateStatus(a.id, 'thinking')
    assert.equal((await manager.get(a.id)).status, 'thinking')
    await manager.update(a.id, { name: '改名后' })
    assert.equal((await manager.get(a.id)).name, '改名后')
  })
})

/** 装载唯一性测试的行样本形状（只喂断言用到的字段）。 */
interface AgentInstanceLike {
  id: string
  name: string
  parentId: string
  status: string
}
