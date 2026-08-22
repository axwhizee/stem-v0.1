// ============================================================
// core/init/system.test.ts —— 系统装配组合根（createStemSystem）单测
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeGateway } from '../gateway'
import type { ConfigPaths, ConfigStore, StemConfig } from '../config'
import type { InitFs, InitToolLoader } from './types'
import { createStemSystem } from './system'
import { makeAgentClassID, makeAgentID, USER_ID } from '../kernel'

function makeDeps(config: StemConfig = {}, fsFiles: Record<string, string> = {}) {
  const store: ConfigStore = {
    file: '/proj/.stem/stem.jsonc',
    load: async () => ({ exists: true, config }),
    save: async () => {},
  }
  const paths: ConfigPaths = {
    projectRoot: '/proj',
    configDir: '/proj/.stem',
    configFile: '/proj/.stem/stem.jsonc',
    toolDir: '/proj/.stem/tool',
    agentDir: '/proj/.stem/agent',
  }
  const fs: InitFs = {
    listFiles: async (dir) => Object.keys(fsFiles).filter((f) => f.startsWith(dir)),
    readText: async (file) => fsFiles[file] ?? '',
  }
  const loader: InitToolLoader = { loadTool: async () => ({}) }
  const gateway = new FakeGateway(() => [
    { type: 'text-delta', text: '你好，我是助手。' },
    { type: 'finish', reason: 'stop' },
  ])
  return { store, paths, fs, loader, gateway }
}

describe('createStemSystem（系统装配组合根）', () => {
  test('装配：user0 实例化（user 类）+ 系统工具 + skill 工具 + pilot 身份', async () => {
    const d = makeDeps()
    const system = await createStemSystem({
      config: { store: d.store, paths: d.paths },
      fs: d.fs,
      tools: d.loader,
      gateway: d.gateway,
      defaultModel: { provider: 'opencode', id: 'test' },
      userHooks: [
        async (ctx) => {
          assert.equal(ctx.pilot.identity, USER_ID)
        },
      ],
    })
    // user0 是普通实例（user 类，根）。
    const user0 = system.kernel.instances.getSync(makeAgentID(USER_ID))
    assert.ok(user0)
    assert.equal(user0!.classRef, makeAgentClassID('user'))
    assert.equal(user0!.parentId, null)
    // 系统工具 + access_reply + skill 已注册。
    assert.ok(await system.tools.get('agent_instantiate'))
    assert.ok(await system.tools.get('access_reply'))
    assert.ok(await system.tools.get('skill'))
    await system.dispose()
  })

  test('pilot.sendMessage：user0 发消息 → agent 回复 → letter 事件', async () => {
    const d = makeDeps({ sendCountdown: 0 })
    const letters: string[] = []
    const system = await createStemSystem({
      config: { store: d.store, paths: d.paths },
      fs: d.fs,
      tools: d.loader,
      gateway: d.gateway,
      defaultModel: { provider: 'opencode', id: 'test' },
      onEvent: (e) => {
        if (e.type === 'letter') letters.push(String(e.letters[0]?.content ?? ''))
      },
    })
    const agentId = await system.pilot.instantiate(
      { className: makeAgentClassID('simple-chat'), userPrompt: '你好' },
      '/proj',
    )
    await system.pilot.sendMessage(agentId, '在吗')
    // 等待 Courier 投递 + agent 处理 + 回信（sendCountdown=0 → 立即）。
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.ok(letters.length >= 1, `应收到 agent 回信（实际 ${letters.length}）`)
    assert.ok(letters.some((t) => t.includes('我是助手')))
    await system.dispose()
  })
})