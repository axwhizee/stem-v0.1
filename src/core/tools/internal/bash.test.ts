// ============================================================
// core/tools/internal/bash.test.ts —— bash 工具单测（fake runner，零平台）
// ============================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBashTool, BASH_DEFAULTS } from './bash'
import type { ShellRunOptions, ShellRunResult, ShellRunner } from './bash'
import type { ToolContext } from '../types'

const ctx: ToolContext = { agentId: 'a1', spaceId: 's1' }

/** 捕获入参的 fake runner（返回固定结果）。 */
function fakeRunner(result: Partial<ShellRunResult> & { stdout?: string } = {}): {
  runner: ShellRunner
  calls: ShellRunOptions[]
} {
  const calls: ShellRunOptions[] = []
  return {
    calls,
    runner: {
      run: async (options) => {
        calls.push(options)
        return {
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
          exitCode: result.exitCode ?? 0,
          timedOut: result.timedOut ?? false,
        }
      },
    },
  }
}

test('成功执行：stdout 原样返回，exit 0 不带尾注', async () => {
  const { runner, calls } = fakeRunner({ stdout: 'hello\n' })
  const tool = createBashTool({ runner })
  const result = await tool.execute({ command: 'echo hello' }, ctx)
  assert.equal(result.text, 'hello\n')
  assert.equal(calls[0]?.timeoutMs, BASH_DEFAULTS.defaultTimeoutMs, '缺省走 BASH_DEFAULTS 超时')
  assert.equal(calls[0]?.cwd, undefined)
  assert.equal(calls[0]?.shell, undefined)
})

test('settings 透传：path/cwd/超时供 runner', async () => {
  const { runner, calls } = fakeRunner({ stdout: 'ok' })
  const tool = createBashTool({
    runner,
    settings: { path: '/bin/dash', cwd: '/work', defaultTimeoutMs: 5000 },
  })
  await tool.execute({ command: 'pwd' }, ctx)
  assert.equal(calls[0]?.shell, '/bin/dash')
  assert.equal(calls[0]?.cwd, '/work')
  assert.equal(calls[0]?.timeoutMs, 5000)
})

test('参数覆盖：timeoutMs/cwd 逐次优先于 settings', async () => {
  const { runner, calls } = fakeRunner({})
  const tool = createBashTool({ runner, settings: { cwd: '/work', defaultTimeoutMs: 5000 } })
  await tool.execute({ command: 'ls', cwd: '/other', timeoutMs: 1500 }, ctx)
  assert.equal(calls[0]?.cwd, '/other')
  assert.equal(calls[0]?.timeoutMs, 1500)
})

test('非零退出码 = 正常结果 + exit code 尾注（不是工具失败）', async () => {
  const { runner } = fakeRunner({ stderr: 'nope', exitCode: 2 })
  const tool = createBashTool({ runner })
  const result = await tool.execute({ command: 'false' }, ctx)
  assert.match(result.text, /\[stderr\]\nnope/)
  assert.match(result.text, /\[exit code: 2\]$/)
  assert.deepEqual(result.metadata?.exitCode, 2)
})

test('超时：强杀标注 + exitCode null 不重复报码', async () => {
  const { runner } = fakeRunner({ stdout: 'partial', timedOut: true, exitCode: null })
  const tool = createBashTool({ runner, settings: { defaultTimeoutMs: 1500 } })
  const result = await tool.execute({ command: 'sleep 10' }, ctx)
  assert.match(result.text, /执行超时（1500ms），进程已被终止/)
  assert.doesNotMatch(result.text, /exit code/)
  assert.equal(result.metadata?.timedOut, true)
})

test('输出截断：上限裁剪 + 省略说明（stdout/stderr 分别计）', async () => {
  const big = 'x'.repeat(100)
  const { runner } = fakeRunner({ stdout: big, stderr: big })
  const tool = createBashTool({ runner, settings: { maxOutputChars: 10 } })
  const result = await tool.execute({ command: 'spam' }, ctx)
  assert.match(result.text, /^x{10}\n…（后续 90 字符已省略）/)
  assert.match(result.text, /\[stdout 已截断.*\| stderr 已截断.*\]/)
})

test('validate：command 非空 + timeoutMs 正数', () => {
  const { runner } = fakeRunner({})
  const tool = createBashTool({ runner })
  assert.ok(tool.validate)
  assert.equal(tool.validate?.({ command: '   ' }), 'command 必须是非空字符串')
  assert.equal(tool.validate?.({ command: 'ls', timeoutMs: 0 }), 'timeoutMs 必须是正数')
  assert.equal(tool.validate?.({ command: 'ls' }), undefined)
})

test('工具固有属性：internal / bash 键 / 必填 command', () => {
  const { runner } = fakeRunner({})
  const tool = createBashTool({ runner })
  assert.equal(tool.id, 'bash')
  assert.equal(tool.accessKey, 'bash')
  assert.equal(tool.kind, 'internal')
  assert.deepEqual(tool.parameters.required, ['command'])
  assert.match(tool.description, /非交互式/)
  assert.match(tool.description, /专用工具/)
})

test('相对 cwd 参数：以 settings.cwd（宿主接线=空间根）为基准解析，不随宿主进程 cwd 漂（验收 P5 回归）', async () => {
  const { runner, calls } = fakeRunner({})
  const tool = createBashTool({ runner, settings: { cwd: '/space/root' } })
  await tool.execute({ command: 'wc', cwd: '.' }, ctx)
  assert.equal(calls[0]?.cwd, '/space/root')
  await tool.execute({ command: 'ls', cwd: 'sub/dir' }, ctx)
  assert.equal(calls[1]?.cwd, '/space/root/sub/dir')
})

test('settings.cwd 缺省（纯 core 测试环境）：参数原样透传交 runner 兜底', async () => {
  const { runner, calls } = fakeRunner({})
  const tool = createBashTool({ runner })
  await tool.execute({ command: 'ls', cwd: '.' }, ctx)
  assert.equal(calls[0]?.cwd, '.')
})
