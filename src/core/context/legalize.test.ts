// ============================================================
// core/context/legalize.test.ts —— 上下文合法化纯函数单测
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { legalize } from './legalize'
import type { ChatMessage } from '../gateway'

const user = (text: string): ChatMessage => ({ role: 'user', content: text })
const assistant = (text: string, toolCalls?: ChatMessage['toolCalls']): ChatMessage => ({
  role: 'assistant',
  content: text,
  ...(toolCalls !== undefined ? { toolCalls } : {}),
})
const tool = (text: string, id: string): ChatMessage => ({ role: 'tool', content: text, toolCallId: id })

describe('legalize（上下文合法化）', () => {
  test('合法序列原样通过（无修改）', () => {
    const seq = [user('hi'), assistant('你好'), user('ok'), assistant('再见')]
    assert.deepEqual(legalize(seq), seq)
  })

  test('悬空 tool_calls 裁剪：无对应结果的调用被剥掉（降级为纯文本 assistant）', () => {
    const seq = [user('读文件'), assistant('', [{ id: 'call_1', name: 'read', arguments: '{}' }])]
    const result = legalize(seq)
    assert.equal(result.length, 2)
    const a = result[1]
    assert.equal(a?.role, 'assistant')
    assert.equal(a?.toolCalls, undefined)
  })

  test('部分兑现：保留有结果的调用，孤儿 tool 结果被剔除', () => {
    const seq = [
      user('双调用'),
      assistant('', [
        { id: 'call_1', name: 'read', arguments: '{}' },
        { id: 'call_2', name: 'write', arguments: '{}' },
      ]),
      tool('read 结果', 'call_1'),
    ]
    const result = legalize(seq)
    // assistant 保留 call_1，call_2 被裁剪；tool(call_1) 保留；call_2 无 tool 消息。
    const a = result[1]
    assert.equal(a?.role, 'assistant')
    assert.deepEqual(
      (a as { toolCalls?: readonly { id: string }[] }).toolCalls?.map((tc) => tc.id),
      ['call_1'],
    )
    assert.deepEqual(
      result.filter((m) => m.role === 'tool').map((m) => m.toolCallId),
      ['call_1'],
    )
  })

  test('孤儿 tool 剔除：无前置声明的 tool 消息被丢弃（含无 toolCallId）', () => {
    const seq = [user('hi'), tool('孤儿结果', 'call_x'), assistant('完成')]
    const result = legalize(seq)
    assert.deepEqual(
      result.map((m) => m.role),
      ['user', 'assistant'],
    )
  })

  test('tool→user 相邻：插入空 assistant 边界占位', () => {
    const seq = [
      user('hi'),
      assistant('', [{ id: 'call_1', name: 'read', arguments: '{}' }]),
      tool('结果', 'call_1'),
      user('继续'),
    ]
    const result = legalize(seq)
    assert.deepEqual(
      result.map((m) => m.role),
      ['user', 'assistant', 'tool', 'assistant', 'user'],
    )
    assert.equal(result[3]?.role, 'assistant')
    assert.equal((result[3] as { content: string }).content, '')
  })

  test('连续多个 tool 后接 user：只在最后一个 tool 后插入边界', () => {
    const seq = [
      user('hi'),
      assistant('', [
        { id: 'call_1', name: 'read', arguments: '{}' },
        { id: 'call_2', name: 'read', arguments: '{}' },
      ]),
      tool('结果1', 'call_1'),
      tool('结果2', 'call_2'),
      user('继续'),
    ]
    const result = legalize(seq)
    assert.deepEqual(
      result.map((m) => m.role),
      ['user', 'assistant', 'tool', 'tool', 'assistant', 'user'],
    )
  })
})