// ============================================================
// core/init/restart.test.ts —— 持久化恢复 e2e（系统级重启语义）
//
// 复用 system.test 的 createStemSystem 装配（FakeGateway + 内存 store），
// 用同一对 MemoryStore 跨"三个生命周期"验证：
//   A：装配 → 对话一轮 → 消息/实例 write-through；
//   B：重启恢复（族谱/上下文/状态归一化/user0 幂等）→ 续对话 → 终止归档；
//   C：再重启（归档不加载、id 防撞）。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeGateway } from '../gateway'
import type { ConfigPaths, ConfigStore, StemConfig } from '../config'
import type { InitFs, InitToolLoader } from './types'
import { createStemSystem } from './system'
import type { StemSystemDeps } from './system'
import { MemoryMessageStore } from '../context'
import { MemoryInstanceStore } from '../kernel'
import { makeAgentClassID, makeAgentID, USER_ID } from '../kernel'
import { messageSeqOf } from '../context'

function makeDeps(config: StemConfig = {}) {
  // S6/R12：家学锚点必填（boot 硬校验）；用例显式给出的 user 字段优先。
  const anchored: StemConfig = { ...config, user: { model: { provider: 'opencode', id: 'test' }, ...config.user } }
  const store: ConfigStore = {
    file: '/proj/.stem/stem.jsonc',
    load: async () => ({ exists: true, config: anchored }),
    save: async () => {},
  }
  const paths: ConfigPaths = {
    projectRoot: '/proj',
    configDir: '/proj/.stem',
    configFile: '/proj/.stem/stem.jsonc',
    toolDir: '/proj/.stem/tool',
    agentDir: '/proj/.stem/agent',
    strategyDir: '/proj/.stem/context',
  }
  const fs: InitFs = { listFiles: async () => [], listDirs: async () => [], readText: async () => '' }
  const loader: InitToolLoader = { loadTool: async () => ({}) }
  return { store, paths, fs, loader }
}

function gatewayReplying(text: string): FakeGateway {
  return new FakeGateway(() => [
    { type: 'text-delta', text },
    { type: 'finish', reason: 'stop' },
  ])
}

function boot(
  d: ReturnType<typeof makeDeps>,
  gateway: FakeGateway,
  stateStore: StemSystemDeps['stateStore'],
  letters: string[],
) {
  return createStemSystem({
    config: { store: d.store, paths: d.paths },
    fs: d.fs,
    tools: d.loader,
    gateway,
    stateStore,
    onEvent: (e) => {
      if (e.type !== 'letter') return
      for (const letter of e.letters) letters.push(String(letter.content ?? ''))
    },
  })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

describe('createStemSystem 重启恢复（持久化 e2e）', () => {
  test('A 对话 → B 恢复续聊 + 归档 → C 归档不加载', async () => {
    const messages = new MemoryMessageStore()
    const instances = new MemoryInstanceStore()
    const stateStore = { messages, instances }
    const d = makeDeps({ sendCountdown: 0 })

    // ---------- 生命周期 A ----------
    const lettersA: string[] = []
    const systemA = await boot(d, gatewayReplying('你好，我是助手。'), stateStore, lettersA)
    const childId = await systemA.pilot.instantiate({ className: 'assistant', userPrompt: '你好' }, '/proj')
    await systemA.pilot.sendMessage(childId, '在吗')
    await settle()
    assert.ok(lettersA.some((t) => t.includes('我是助手')), 'A：首轮对话回复送达')

    const contextCountA = systemA.kernel.repository.list(childId).length
    const idsA = new Set(systemA.kernel.repository.list(childId).map((m) => m.id))
    assert.ok(contextCountA >= 3, 'A：system+user+assistant 已入库')
    await systemA.dispose()

    // ---------- 生命周期 B：重启恢复 ----------
    const lettersB: string[] = []
    const systemB = await boot(d, gatewayReplying('我恢复啦。'), stateStore, lettersB)
    // 族谱恢复：user0 + child（user0 幂等，未重复注册）。
    const agentsB = await systemB.pilot.listAgents()
    assert.equal(agentsB.length, 2, 'B：重启后族谱应恰为 user0 + child')
    assert.ok(agentsB.some((a) => a.id === USER_ID) && agentsB.some((a) => a.id === childId))
    // 上下文恢复：child 消息箱完整。
    assert.equal(systemB.kernel.repository.has(childId), true)
    assert.equal(systemB.kernel.repository.list(childId).length, contextCountA)
    // 状态归一化：轮尾 holding → interrupted（进程已死语义，可恢复）。
    assert.equal(systemB.kernel.instances.getSync(makeAgentID(childId))?.status, 'interrupted')
    // 零重放：重启接线不产生任何新信件（lastSentIds 已由恢复行预置）。
    await settle()
    assert.equal(lettersB.length, 0, `B：重启后不应重放旧信，实际 ${lettersB.length} 封`)

    // 续对话：恢复接线生效（管理员/快递员重挂 → 送信 → 回复送达）。
    await systemB.pilot.sendMessage(childId, '继续')
    await settle()
    assert.ok(lettersB.some((t) => t.includes('我恢复啦')), 'B：恢复后续聊回复送达')
    const idsB = systemB.kernel.repository.list(childId).map((m) => m.id)
    assert.ok(idsB.length > contextCountA, 'B：新消息入库')
    const maxA = Math.max(...[...idsA].map(messageSeqOf))
    assert.ok(
      idsB.filter((id) => !idsA.has(id)).every((id) => messageSeqOf(id) > maxA),
      'B：恢复后消息 id 续接不冲突',
    )
    // write-through 落 store：B 新增消息同步进了持久化层。
    assert.equal(messages.loadBoxes().find((b) => b.agentId === childId)?.messages.length, idsB.length)

    // 终止：实例消行 + 消息归档（语料保留在 store 底层）。
    await systemB.pilot.terminate(childId)
    assert.equal(systemB.kernel.instances.getSync(makeAgentID(childId)), undefined)
    assert.equal(messages.loadBoxes().some((b) => b.agentId === childId), false, 'B：归档后不再出现在恢复视图')
    assert.equal(instances.loadAll().some((i) => i.id === childId), false)
    await systemB.dispose()

    // ---------- 生命周期 C：归档不加载 + 防撞 ----------
    const systemC = await boot(d, gatewayReplying('新助手上线。'), stateStore, [])
    const agentsC = await systemC.pilot.listAgents()
    assert.equal(agentsC.length, 1, 'C：仅剩 user0（child 归档）')
    assert.equal(systemC.kernel.repository.has(childId), false)
    const newId = await systemC.pilot.instantiate({ className: 'assistant', userPrompt: 'hi' }, '/proj')
    await systemC.pilot.sendMessage(newId, '在吗')
    await settle()
    const freshIds = systemC.kernel.repository.list(newId).map((m) => m.id)
    assert.ok(
      freshIds.every((id) => messageSeqOf(id) > maxA),
      'C：新生命周期 id 越过历史（含归档）最大序号',
    )
    await systemC.dispose()
  })
  test('S6/R14：显式模型随实例行落盘 → 重启 explicit 层延续；setModel 不级联子女快照', async () => {
    const messages = new MemoryMessageStore()
    const instances = new MemoryInstanceStore()
    const stateStore = { messages, instances }
    const d = makeDeps({ sendCountdown: 0 })

    // ---------- 生命周期 A：显式出生 + 运行改写 ----------
    const systemA = await boot(d, gatewayReplying('a'), stateStore, [])
    const parentId = await systemA.pilot.instantiate(
      { className: 'assistant', userPrompt: '父', model: { provider: 'fake', id: 'birth-p' } },
      '/proj',
    )
    assert.deepEqual(systemA.kernel.lineage.modelOf(parentId), { ref: { provider: 'fake', id: 'birth-p' }, origin: 'explicit' })
    const parentInstance = systemA.kernel.instances.getSync(makeAgentID(parentId))!
    const childId = await systemA.kernel.instantiateInSpace(
      { className: makeAgentClassID('assistant'), parentId: parentInstance.id, userPrompt: '子' },
      parentInstance.spaceId,
    )
    // 子女出生快照：继承父的显式层。
    assert.deepEqual(systemA.kernel.lineage.modelOf(childId), { ref: { provider: 'fake', id: 'birth-p' }, origin: 'inherited' })
    // 运行改写（pilot 通道）→ 不级联既有子女。
    await systemA.pilot.setModel(parentId, { provider: 'fake', id: 'swapped' })
    assert.deepEqual(systemA.kernel.lineage.modelOf(parentId), { ref: { provider: 'fake', id: 'swapped' }, origin: 'explicit' })
    assert.deepEqual(systemA.kernel.lineage.modelOf(childId), { ref: { provider: 'fake', id: 'birth-p' }, origin: 'inherited' }, '改父不动子（族规=出生快照）')
    // 实例行持久化（R14：行 JSON 扩展零 schema 迁移）。
    assert.deepEqual(instances.loadAll().find((row) => row.id === parentId)?.model, { provider: 'fake', id: 'swapped' })
    await systemA.dispose()

    // ---------- 生命周期 B：重启 replay → 配置相全量续谈 ----------
    const lettersB: string[] = []
    const systemB = await boot(d, gatewayReplying('恢复后回复'), stateStore, lettersB)
    assert.deepEqual(systemB.kernel.lineage.modelOf(parentId), { ref: { provider: 'fake', id: 'swapped' }, origin: 'explicit' })
    assert.deepEqual(systemB.kernel.lineage.modelOf(childId), { ref: { provider: 'fake', id: 'birth-p' }, origin: 'inherited' })
    // 续谈可用（模型链在恢复态完整）。
    await systemB.pilot.sendMessage(parentId, '继续')
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.ok(lettersB.some((text) => text.includes('恢复后回复')), 'B：重启后对话链路正常')
    await systemB.dispose()
  })
})
