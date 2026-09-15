// ============================================================
// shell/dashboard/dashboard.test.ts —— 数据层/清理/标本清单（真库 + 真装配）
// ============================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSqliteStateStore } from '../cli/storage'
import { DefaultRepository, PersistedRepository } from '../../src/core/context'
import {
  DefaultTemplateRegistry,
  DefaultInstanceManager,
  PersistedInstanceManager,
  makeAgentClassID,
  makeAgentID,
} from '../../src/core/kernel'
import type { AgentClass } from '../../src/core/kernel'
import { cleanupPreview, runCleanup } from './cleanup'
import { dashAgents, listMessages, openDb, rawTable, summary, tokenStats } from './db'
import { getInventory } from './inventory'

const cls: AgentClass = {
  name: makeAgentClassID('probe-worker'),
  description: 'w',
  systemPrompt: 'work',
  tools: {},
}

/** 造一份有账目的空间 DB：两 agent 语料（含真实 tokens/角色混合）+ 实例三态。 */
async function seedSpace(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'stem-dash-'))
  const file = join(dir, 'stem.db')
  const store = createSqliteStateStore(file)
  const repository = new PersistedRepository(new DefaultRepository(), store.messages)
  const manager = new PersistedInstanceManager(new DefaultInstanceManager(new DefaultTemplateRegistry([cls])), store.instances)

  await repository.register('0', 'sys-prompt')
  await repository.append('0', { message: { role: 'user', content: '<sender id="user#0" at="260908.1234">你好世界</sender>' }, from: '0', tokens: 7 })
  await repository.append('0', { message: { role: 'assistant', content: 'hi' }, tokens: 40 })
  await repository.append('0', { message: { role: 'tool', content: 'r', toolCallId: 'c1' }, tokens: 12 })
  await repository.append('0', { message: { role: 'assistant', content: 'done' }, tag: 'summary', tokens: 5 })
  await repository.register('a2', 'sys2')
  await repository.append('a2', { message: { role: 'user', content: '干活' }, from: '0', tokens: 3 })

  // 路径 id 标本：根实例 `0`（箱同名）+ 子 `1` = ghost（terminated）；a2 为孤儿箱（无实例行）。
  await manager.instantiate({ className: cls.name, parentId: null, userPrompt: '你好世界', name: 'root-probe' })
  await manager.instantiate({ className: cls.name, parentId: makeAgentID('0'), userPrompt: 'go', name: 'ghost' })
  await manager.updateStatus('1' as never, 'interrupted')
  // SQL 直改为 terminated（updateStatus 状态机不含该迁移，测试造终态行）。
  const db = openDb(file, { readonly: false })!
  db.prepare(`UPDATE instances SET instance = json_set(instance, '$.status', 'terminated') WHERE id = '1'`).run()
  db.close()
  store.close()
  return { dir, file }
}

function open(file: string) {
  return openDb(file, { readonly: false })!
}

test('仪表盘数据层：汇总/族谱/token 账目/语料/原表 全查询面', async () => {
  const { dir, file } = await seedSpace()
  try {
    const db = open(file)
    const sum = summary(db, file)
    assert.equal(sum.messages.total, 7) // a1×5 + a2×2（register 自带 system 行）
    assert.equal(sum.tokensTotal, 71) // 67 + 4（system 行按 ceil(chars/4) 估算入账）
    assert.equal(sum.instances.total, 2)
    assert.equal(sum.instances.byStatus.terminated, 1)
    assert.equal(sum.schemaVersion, 3)
    assert.ok(sum.lastActivity !== null)

    const agents = dashAgents(db)
    const root = agents.find((a) => a.id === '0')
    assert.ok(root)
    assert.equal(root.msgs, 5)
    assert.equal(root.tokens, 67)
    assert.equal(root.lastPrompt, '你好世界') // 最新 user 信剥 sender 戳（B4 含 at= 属性）
    assert.equal(root.lastPromptFrom, 'user#0')
    assert.equal(root.status, 'idle')
    const ghost = agents.find((a) => a.id === '1')
    assert.equal(ghost?.status, 'terminated')
    assert.equal(ghost?.parentId, '0')
    assert.equal(ghost?.name, 'ghost')

    const tk = tokenStats(db)
    assert.equal(tk.byAgent[0]?.agentId, '0') // tokens 降序
    assert.equal(tk.byAgent[0]?.byRole.assistant, 45)
    assert.equal(tk.byAgent[0]?.byRole.system, 3)
    assert.equal(tk.byAgent[0]?.byTag.summary, 5)
    assert.equal(tk.total.tokens, 71)
    assert.ok(tk.byDay.length >= 1)

    const page = listMessages(db, { agentId: '0', limit: 2 })
    assert.equal(page.total, 5)
    assert.equal(page.rows.length, 2)
    assert.equal(page.rows[0]?.role, 'system')

    const raw = rawTable(db, 'instances', 10)
    assert.equal(raw.total, 2)
    assert.ok(typeof raw.rows[0]?.instance === 'string' && String(raw.rows[0]?.instance).startsWith('{'))

    // 只读连接拒绝写（法医默认姿态的机制保证）。
    const ro = openDb(file)!
    assert.throws(() => ro.prepare('DELETE FROM messages').run())
    ro.close()
    db.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('清理工具：孤儿/terminated GC + 定点 purge（active 需 force）+ VACUUM', async () => {
  const { dir, file } = await seedSpace()
  try {
    const db = open(file)
    const preview = cleanupPreview(db)
    assert.deepEqual([...preview.orphanAgents], ['a2'])
    assert.deepEqual([...preview.terminatedAgents], ['1'])
    assert.equal(preview.orphanRows, 2) // a2 箱 = system + user 两行

    const gcOrphan = runCleanup(db, 'gc-orphans')
    assert.ok(gcOrphan.ok)
    assert.equal(gcOrphan.deletedRows, 2)
    assert.equal(cleanupPreview(db).orphanAgents.length, 0)

    const gcTerm = runCleanup(db, 'gc-terminated')
    assert.ok(gcTerm.ok)
    assert.equal(gcTerm.deletedRows, 0) // 墓碑 0-1 无自己的语料箱

    // 定点销毁 0：idle 态 → 默认拒绝，force 放行。
    const blocked = runCleanup(db, 'purge-agent', { agentId: '0' })
    assert.equal(blocked.ok, false)
    assert.match(blocked.note ?? '', /非 terminated/)
    const forced = runCleanup(db, 'purge-agent', { agentId: '0', force: true })
    assert.ok(forced.ok)
    assert.equal(forced.deletedRows, 5)
    assert.equal(dashAgents(db).find((a) => a.id === '0'), undefined)

    const vac = runCleanup(db, 'vacuum')
    assert.ok(vac.ok)
    db.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('资源清单：纯内存标本装配 = 矩阵真实结果（三态分层 + user 类基因 + init 报告）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stem-dash-inv-'))
  try {
    await mkdir(join(dir, '.stem'), { recursive: true })
    await writeFile(
      join(dir, '.stem', 'stem.jsonc'),
      `{
  "providers": { "stub": { "base_url": "https://stub.invalid/v1", "key_env": "STEM_DASH_TEST_KEY" } },
  "user": { "model": "stub/probe-model" },
  "extensions": { "tools": { "dash-probe-tool": "ignore" }, "agent": [] }
}`,
      'utf8',
    )
    // custom 目录形态工具（无 import——运行时形状校验即可）。
    await mkdir(join(dir, '.stem', 'tools', 'dash-probe-tool'), { recursive: true })
    await writeFile(
      join(dir, '.stem', 'tools', 'dash-probe-tool', 'dash-probe-tool.ts'),
      `export default { id: 'dash-probe-tool', description: '探针工具', parameters: { type: 'object', properties: {} }, execute: () => ({ text: 'probe' }) }`,
      'utf8',
    )
    await mkdir(join(dir, '.stem', 'agent'), { recursive: true })
    await writeFile(join(dir, '.stem', 'agent', 'probe-agent.md'), '---\ndescription: 探针类\n---\nbody', 'utf8')

    const inv = await getInventory(dir)
    assert.equal(inv.homeModel, 'stub/probe-model')
    assert.equal(inv.providers.stub?.keyPresent, false)
    // 工具三态：custom 装载、extension 点名 [] 全关、internal 恒在（bash = 默认注入 runner）。
    const custom = inv.tools.find((t) => t.id === 'dash-probe-tool')
    assert.ok(custom, 'custom 点名工具应装载（目录形态 <名>/<名>.ts 解析命中）')
    assert.equal(custom.kind, 'custom')
    assert.equal(custom.visibleToRoot, false, '出生 ignore = 背景在场不暴露（不设防）')
    assert.ok(inv.tools.some((t) => t.id === 'bash' && t.kind === 'internal' && t.visibleToRoot))
    assert.ok(!inv.tools.some((t) => t.id === 'read'), 'extensions.tools 未点名 read → 不存在于世界')
    // 类清单分层：internal（user/assistant 占位）+ custom 扫描。
    const layers = new Map(inv.classes.map((c) => [c.name, c.layer]))
    assert.equal(layers.get('user'), 'internal')
    assert.equal(layers.get('assistant'), 'internal')
    assert.equal(layers.get('probe-agent'), 'custom')
    // 策略维度（标本注册表实况）：内置 classic/none 必须可见，classic 有异步 process + 动作面。
    const strat = new Map(inv.strategies.map((s) => [s.name, s]))
    assert.equal(strat.get('classic')?.layer, 'internal')
    assert.equal(strat.get('classic')?.hasProcess, true)
    assert.ok((strat.get('classic')?.actions.length ?? 0) > 0, 'classic 应有 actions 面（compact）')
    assert.equal(strat.get('none')?.layer, 'internal')
    assert.equal(strat.get('none')?.hasProcess, false)
    assert.deepEqual(inv.initIssues, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
