// ============================================================
// core/tools/output.test.ts —— 统一输出成形（成功/失败同入口 + 窗口限制）
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { formatToolError, formatToolOutput } from './output'
import type { ToolError } from './types'

describe('formatToolOutput', () => {
  test('成功结果：未设窗口 → 原样返回', () => {
    assert.equal(formatToolOutput({ text: 'hello' }), 'hello')
  })

  test('outputLimit=0 视为不启用（零行为变更）', () => {
    assert.equal(formatToolOutput({ text: 'abcdef' }, { outputLimit: 0 }), 'abcdef')
  })

  test('outputLimit 截断：保留前段 + 省略说明', () => {
    const out = formatToolOutput({ text: 'abcdefghij' }, { outputLimit: 4 })
    assert.equal(out, 'abcd\n…（输出超上限 4 字符，已截断 6 字符）')
  })

  test('不超限不裁剪', () => {
    assert.equal(formatToolOutput({ text: 'abc' }, { outputLimit: 10 }), 'abc')
  })

  test('错误与成功同一入口：错误走判别联合渲染', () => {
    const err: ToolError = { kind: 'execution_failed', tool: 'bash', message: 'boom' }
    assert.equal(formatToolOutput(err), '[ToolError execution_failed] boom')
  })

  test('错误窗口同样受限（成功/失败同裁剪）', () => {
    const err: ToolError = { kind: 'execution_failed', tool: 'x', message: '0123456789abcdefghij' }
    const out = formatToolOutput(err, { outputLimit: 30 })
    assert.match(out, /^\[ToolError execution_failed\]/)
    assert.match(out, /已截断/)
  })
})

describe('formatToolError（kind 必显示 + 细节退化链）', () => {
  test('message 优先', () => {
    assert.equal(formatToolError({ kind: 'invalid_arguments', tool: 't', message: '参数错' }), '[ToolError invalid_arguments] 参数错')
  })

  test('无 message 时用 feedback（access_rejected）', () => {
    assert.equal(
      formatToolError({ kind: 'access_rejected', tool: 't', accessKey: 'k', feedback: '不许' }),
      '[ToolError access_rejected] 不许',
    )
  })

  test('无 message/feedback 时退化到 accessKey', () => {
    assert.equal(formatToolError({ kind: 'access_denied', tool: 't', accessKey: 'bash' }), '[ToolError access_denied] 访问键 bash 被拒')
  })

  test('无以上细节时退化到 tool 名', () => {
    assert.equal(formatToolError({ kind: 'tool_not_found', tool: 'nope' }), '[ToolError tool_not_found] 工具 nope')
  })
})
