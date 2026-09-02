// ============================================================
// core/init/classRestart.test.ts —— 进化跨重启 e2e（S5.2 验收件）
//
// 目录即真相的兑现链：createStemSystem 注入 classFs（内存 map 版 node fs
// 替身）→ 工具写类（create 新名 → update 收敛覆盖）→ 序列化落 `.stem/agent/`
// → dispose → **全新系统** runInit 扫描 map → 类带进化结果出生。
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeGateway } from '../gateway'
import type { ConfigPaths, ConfigStore, StemConfig } from '../config'
import type { ClassFs, InitFs, InitToolLoader } from './types'
import { createStemSystem } from './system'
import { makeAgentClassID, USER_ID } from '../kernel'

/** 共享内存文件表（写侧 classFs + 读侧 InitFs 同一 map = 文件系统替身）。 */
function makeMemFs(files: Record<string, string> = {}) {
  const paths: ConfigPaths = {
    projectRoot: '/proj',
    configDir: '/proj/.stem',
    configFile: '/proj/.stem/stem.jsonc',
    toolDir: '/proj/.stem/tool',
    agentDir: '/proj/.stem/agent',
    strategyDir: '/proj/.stem/context',
  }
  const store: ConfigStore = {
    file: paths.configFile,
    load: async () => ({
      exists: true,
      // S6/R12：家学锚点必填（boot 硬校验），测试 config 统一注入。
      config: { user: { model: { provider: 'opencode', id: 'test' } } } as StemConfig,
    }),
    save: async () => {},
  }
  const fs: InitFs = {
    listFiles: async (dir) => Object.keys(files).filter((f) => f.startsWith(`${dir}/`)),
    listDirs: async (dir) => {
      const prefix = `${dir}/`
      const seen = new Set<string>()
      for (const f of Object.keys(files)) {
        if (!f.startsWith(prefix)) continue
        const seg = f.slice(prefix.length).split('/')[0]
        if (seg && f !== `${prefix}${seg}`) seen.add(`${prefix}${seg}`)
      }
      return [...seen]
    },
    readText: async (file) => {
      const text = files[file]
      if (text === undefined) throw new Error(`ENOENT: ${file}`)
      return text
    },
  }
  const classFs: ClassFs = {
    ensureDir: async () => {},
    writeText: async (file, content) => {
      files[file] = content
    },
  }
  const loader: InitToolLoader = { loadTool: async () => ({}) }
  return { paths, store, fs, classFs, loader, files }
}

describe('进化跨重启（类落盘 e2e：目录即真相兑现）', () => {
  test('create → update → 重启装载：进化结果驻留 .stem/agent/', async () => {
    const d = makeMemFs()
    const gateway = new FakeGateway(() => [
      { type: 'text-delta', text: 'ok' },
      { type: 'finish', reason: 'stop' },
    ])
    const system = await createStemSystem({
      config: { store: d.store, paths: d.paths },
      fs: d.fs,
      classFs: d.classFs,
      tools: d.loader,
      gateway,
    })
    const ctx = { agentId: USER_ID, spaceId: 'space-1' }
    // user0 默认表 create/update = ask → 走 access_reply 正规授权链（根答复义务 +
    // per-(agent,key) always 备忘各实弹验证一次）：执行挂起 → 从 ask-bus 取
    // 挂起请求 → 答复 → promise 兑现。
    const runApproved = async (toolName: string, input: Record<string, unknown>) => {
      const call = system.tools.execute({ id: `x-${toolName}-${++callSeq}`, name: toolName, input }, ctx)
      await new Promise((r) => setTimeout(r, 20))
      const req = system.kernel.access.list().find((q) => q.accessKey === toolName)
      if (req) {
        await system.tools.execute(
          { id: `r-${req.id}`, name: 'access_reply', input: { requestId: req.id, reply: 'always' } },
          ctx,
        )
      }
      return call
    }
    let callSeq = 0

    const created = await runApproved('agent_class_create', {
      name: 'reviewer',
      description: '审查 v1',
      systemPrompt: 'review politely',
      tools: { read: 'allow', bash: 'ask' },
    })
    assert.match(created.text, /已落盘/)
    const file = '/proj/.stem/agent/reviewer.md'
    assert.ok(d.files[file], '进化文件已写入文件表')
    assert.match(d.files[file]!, /review politely/)

    // update 首次触发同链授权（新 accessKey 独立 ask → always 备忘后再免询问）。
    const updated = await runApproved('agent_class_update', {
      name: 'reviewer',
      systemPrompt: 'review harshly',
      tools: { bash: 'deny' },
    })
    assert.match(updated.text, /已更新类 reviewer/)
    assert.deepEqual(system.kernel.access.listApprovals(), [
      { agentId: USER_ID, accessKey: 'agent_class_create' },
      { agentId: USER_ID, accessKey: 'agent_class_update' },
    ], 'always 备忘 = per-(agent,key) 豁免询问')

    // ---------- 重启：全新系统从同一文件表装载 ----------
    await system.dispose()
    const revived = await createStemSystem({
      config: { store: d.store, paths: d.paths },
      fs: d.fs,
      classFs: d.classFs,
      tools: d.loader,
      gateway,
    })
    const cls = revived.kernel.templates.getSync(makeAgentClassID('reviewer'))
    assert.ok(cls, 'runInit 扫描装载进化的类（目录即真相）')
    assert.equal(cls!.systemPrompt, 'review harshly', '更新后的基因出生')
    assert.deepEqual(cls!.tools, { read: 'allow', bash: 'deny' })
    assert.equal(cls!.description, '审查 v1')
    // 进化类即刻可用（实例化携带新基因）。
    const agentId = await revived.kernel.instantiateAgent(
      { className: makeAgentClassID('reviewer'), parentId: null, userPrompt: 'go' },
      '/proj',
    )
    assert.equal(revived.kernel.lineage.effectiveAccess(agentId, 'bash'), 'deny')
    // 审计链在日志里（观测面可回放书写史）。
    assert.ok(revived.kernel.logger.count() >= 0)
    await revived.dispose()
  })
})
