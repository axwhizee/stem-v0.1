// ============================================================
// core/main/system.test.ts —— 系统装配组合根（createStemSystem）单测
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeGateway } from '../gateway'
import type { ConfigPaths, ConfigStore, StemConfig } from '../config'
import type { InitFs, InitToolLoader } from './types'
import { createStemSystem } from './system'
import { makeAgentClassID, makeAgentID, parentIdOf, ROOT_ID } from '../kernel'

/** user 类 model 基因（boot 必填：config.user.model）。 */
const HOME: StemConfig = { user: { model: { provider: 'fake', id: 'home-model' } } }

function makeDeps(
  config: StemConfig = {},
  fsFiles: Record<string, string> = {},
  opts: { exists?: boolean; captureSave?: (text: string) => void } = {},
) {
  const exists = opts.exists ?? true
  const store: ConfigStore = {
    file: '/proj/.stem/stem.jsonc',
    load: async () => ({ exists, config: exists ? config : {}, ...(exists ? { raw: '{}' } : {}) }),
    save: async (text) => opts.captureSave?.(text),
  }
  const paths: ConfigPaths = {
    projectRoot: '/proj',
    configDir: '/proj/.stem',
    configFile: '/proj/.stem/stem.jsonc',
    toolDir: '/proj/.stem/tool',
    agentDir: '/proj/.stem/agent',
    strategyDir: '/proj/.stem/context',
  }
  const fs: InitFs = {
    listFiles: async (dir) => Object.keys(fsFiles).filter((f) => f.startsWith(dir)),
    listDirs: async (dir) => {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`
      const seen = new Set<string>()
      for (const f of Object.keys(fsFiles)) {
        if (!f.startsWith(prefix)) continue
        const seg = f.slice(prefix.length).split('/')[0]
        if (seg && f !== `${prefix}${seg}`) seen.add(`${prefix}${seg}`)
      }
      return [...seen]
    },
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
  test('装配：根实例化（user 类）+ 系统工具 + skill 工具 + pilot 身份', async () => {
    const d = makeDeps(HOME)
    const system = await createStemSystem({
      config: { store: d.store, paths: d.paths },
      fs: d.fs,
      tools: d.loader,
      gateway: d.gateway,
      userHooks: [
        async (ctx) => {
          assert.equal(ctx.pilot.identity, ROOT_ID)
        },
      ],
    })
    // user#0 是普通实例（user 类，根）。
    const rootInst = system.kernel.instances.getSync(makeAgentID(ROOT_ID))
    assert.ok(rootInst)
    assert.equal(rootInst!.classRef, makeAgentClassID('user'))
    assert.equal(parentIdOf(rootInst!.id), null)
    // S6/R11：单空间——kernel.project = paths.projectRoot，无 spaces 表。
    assert.equal(system.kernel.project, '/proj', 'user#0 与后代共享项目身份')
    assert.equal(parentIdOf(rootInst!.id), null)
    // 根绑定 = user 类基因（与非根同一 class 层）。
    assert.deepEqual(system.kernel.lineage.modelOf(ROOT_ID), {
      ref: { provider: 'fake', id: 'home-model' },
      origin: 'class',
    })
    // 系统工具已注册；skill 子系统已随 S7 拆除（core 不再有 skill）。
    assert.ok(await system.tools.get('agent_instantiate'))
    const ids = (await system.tools.list()).map((t) => t.id)
    assert.ok(!ids.includes('skill'), 'S7：系统级 skill 工具已废除')
    assert.ok(!ids.includes('access_reply'), '权限审批工具已删除')
    // 未注入 ShellRunner → bash 不装配（core 零平台依赖）。
    assert.ok(!ids.includes('bash'))
    await system.dispose()
  })

  test('bash 装配：注入 ShellRunner 才注册，config.bash 参数流入 runner', async () => {
    const d = makeDeps({ ...HOME, bash: { path: '/bin/dash', defaultTimeoutMs: 2000, cwd: '/proj/sub' } })
    const calls: { command: string; cwd?: string; timeoutMs: number; shell?: string }[] = []
    const system = await createStemSystem({
      config: { store: d.store, paths: d.paths },
      fs: d.fs,
      tools: d.loader,
      gateway: d.gateway,
      shellRunner: {
        run: async (opts) => {
          calls.push(opts)
          return { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false }
        },
      },
    })
    const bash = await system.tools.get('bash')
    assert.ok(bash)
    await bash!.execute({ command: 'echo hi' }, { agentId: 'a1' })
    assert.deepEqual(calls[0], { command: 'echo hi', cwd: '/proj/sub', timeoutMs: 2000, shell: '/bin/dash' })
    await system.dispose()
  })

  test('config.user 对象全生效：user#0 人格/整表权限/面板无策略 note；context 映射 compact 参数', async () => {
    const d = makeDeps({
      user: {
        model: { provider: 'fake', id: 'home-model' },
        systemPrompt: '你是根。',
        // 整表替换语义：给定即全部（键即白名单）。
        tools: { read: 'allow', agent_terminate: 'deny' },
      },
      context: { window: 100, compact: { threshold: 0.5, keepRecentTurns: 2 } },
      sendCountdown: 0,
    })
    const system = await createStemSystem({
      config: { store: d.store, paths: d.paths },
      fs: d.fs,
      tools: d.loader,
      gateway: d.gateway,
    })
    // user#0 人格进配置文件（面板态不跑 LLM 但 transcript 真实）。
    const state = await system.kernel.contextManager.getState(ROOT_ID)
    const systemLine = String(state.messages.find((m) => m.message.role === 'system')!.message.content)
    assert.match(systemLine, /你是根。/)
    assert.ok(!systemLine.includes('<stem_context>'), '面板绑定 none 策略——不注入 classic note')
    // user.tools 整表替换：声明生效、默认表被替换。
    assert.equal(system.kernel.lineage.effectiveAccess(ROOT_ID, 'read'), 'allow')
    assert.equal(system.kernel.lineage.effectiveAccess(ROOT_ID, 'agent_terminate'), 'deny')
    assert.equal(system.kernel.lineage.effectiveAccess(ROOT_ID, 'agent_instantiate'), 'deny', '未列出 = 白名单封闭')
    // config.context 已映射（缺省参数兜底不炸；compact 动作可执行）。
    const result = await system.kernel.contextManager.runStrategyAction(
      await system.kernel.getOrCreateAgent(makeAgentClassID('assistant'), '/proj'),
      'compact',
    )
    assert.match(result, /轮数不足|已压缩|无历史消息/)
    await system.dispose()
  })

  test('pilot.sendMessage：user#0 发消息 → agent 回复 → letter 事件', async () => {
    const d = makeDeps({ ...HOME, sendCountdown: 0 })
    const letters: string[] = []
    const system = await createStemSystem({
      config: { store: d.store, paths: d.paths },
      fs: d.fs,
      tools: d.loader,
      gateway: d.gateway,
      onEvent: (e) => {
        if (e.type === 'letter') letters.push(String(e.letters[0]?.content ?? ''))
      },
    })
    const agentId = await system.pilot.instantiate(
      { className: makeAgentClassID('assistant'), userPrompt: '你好' },
    )
    await system.pilot.sendMessage(agentId, '在吗')
    // 等待 Courier 投递 + agent 处理 + 回信（sendCountdown=0 → 立即）。
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.ok(letters.length >= 1, `应收到 agent 回信（实际 ${letters.length}）`)
    assert.ok(letters.some((t) => t.includes('我是助手')))
    await system.dispose()
  })

  test('R12 user 类 model 必填：缺 config.user.model → boot fail-fast', async () => {
    const d = makeDeps({})
    await assert.rejects(
      () =>
        createStemSystem({
          config: { store: d.store, paths: d.paths },
          fs: d.fs,
          tools: d.loader,
          gateway: d.gateway,
        }),
      (e: unknown) => {
        const err = e as { kind?: string; message?: string }
        return err.kind === 'invalid_config' && err.message?.includes('user.model') === true
      },
    )
  })

  test('首启自举：config 文件不存在 → 内存等效 = 首启模板（user.model = opencode-go），runInit 落盘同一文本', async () => {
    let savedText: string | undefined
    const d = makeDeps({}, {}, { exists: false, captureSave: (text) => (savedText = text) })
    const system = await createStemSystem({
      config: { store: d.store, paths: d.paths },
      fs: d.fs,
      tools: d.loader,
      gateway: d.gateway,
    })
    // 模板 user.model = opencode-go/deepseek-v4-flash（R2 预设 = 模板数据）。
    assert.deepEqual(system.kernel.lineage.modelOf(ROOT_ID), {
      ref: { provider: 'opencode-go', id: 'deepseek-v4-flash' },
      origin: 'class',
    })
    assert.ok(savedText !== undefined && savedText.includes('"providers"'), '首启模板已落盘')
    await system.dispose()
  })
})
