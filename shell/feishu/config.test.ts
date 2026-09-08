// ============================================================
// shell/feishu/config.test.ts —— 平台自治理配置（装载 + jsonc 定点回写）
//
// 回写面是本批新机制：/new /use /exit 的会话目标、主人会话、补偿增量
// 起点都要**写回用户手编的 feishu.jsonc**——保注释、保排版是硬要求
// （用户主权文件不许被机器整形毁容）。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadFeishuConfig, patchFeishuConfig, FEISHU_CONFIG_DEFAULTS } from './config'

function space(): string {
  const root = mkdtempSync(join(tmpdir(), 'feishu-cfg-'))
  mkdirSync(join(root, '.stem'), { recursive: true })
  return root
}

describe('feishu.jsonc 装载', () => {
  test('缺文件 = 全缺省；未知顶层键 fail-fast', () => {
    const root = space()
    assert.deepEqual(loadFeishuConfig(root), FEISHU_CONFIG_DEFAULTS)
    writeFileSync(join(root, '.stem', 'feishu.jsonc'), '{ "ownerOpenIds": ["a"], "nonsense": 1 }')
    assert.throws(() => loadFeishuConfig(root), /未知顶层键/)
    rmSync(root, { recursive: true, force: true })
  })

  test('sessions/ownerChatId/lastSeenAt 读取', () => {
    const root = space()
    writeFileSync(join(root, '.stem', 'feishu.jsonc'), JSON.stringify({
      ownerOpenIds: ['ou_x'],
      sessions: { oc_a: 'kid7' },
      ownerChatId: 'oc_a',
      lastSeenAt: { oc_a: 12345 },
    }))
    const c = loadFeishuConfig(root)
    assert.deepEqual({ ...c.sessions }, { oc_a: 'kid7' })
    assert.equal(c.ownerChatId, 'oc_a')
    assert.equal(c.lastSeenAt['oc_a'], 12345)
    rmSync(root, { recursive: true, force: true })
  })
})

describe('feishu.jsonc 定点回写（保注释律）', () => {
  test('session 写入/解除 + ownerChat + seen，用户注释原样健在', () => {
    const root = space()
    const file = join(root, '.stem', 'feishu.jsonc')
    writeFileSync(file, '{\n  // 主人白名单（手编注释，机器不得毁）\n  "ownerOpenIds": ["ou_x"],\n  "secretaryClass": ""\n}\n')

    patchFeishuConfig(root, { kind: 'session', chatId: 'oc_a', target: 'kid7' })
    patchFeishuConfig(root, { kind: 'ownerChat', chatId: 'oc_a' })
    patchFeishuConfig(root, { kind: 'seen', chatId: 'oc_a', at: 999 })

    const text = readFileSync(file, 'utf8')
    assert.match(text, /主人白名单（手编注释，机器不得毁）/, '注释保留')
    assert.match(text, /"secretaryClass": ""/, '既有键保留')
    const c = loadFeishuConfig(root)
    assert.equal(c.sessions['oc_a'], 'kid7')
    assert.equal(c.ownerChatId, 'oc_a')
    assert.equal(c.lastSeenAt['oc_a'], 999)

    // 覆盖 + 解除。
    patchFeishuConfig(root, { kind: 'session', chatId: 'oc_a', target: 'kid8' })
    assert.equal(loadFeishuConfig(root).sessions['oc_a'], 'kid8')
    patchFeishuConfig(root, { kind: 'session', chatId: 'oc_a', target: null })
    assert.equal(loadFeishuConfig(root).sessions['oc_a'], undefined, 'null = 键删除')
    rmSync(root, { recursive: true, force: true })
  })

  test('缺文件起步：回写以最小骨架开档且可装载', () => {
    const root = space()
    patchFeishuConfig(root, { kind: 'session', chatId: 'oc_b', target: 'kid9' })
    assert.equal(loadFeishuConfig(root).sessions['oc_b'], 'kid9')
    rmSync(root, { recursive: true, force: true })
  })
})
