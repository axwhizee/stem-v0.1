// ============================================================
// core/context/legalize.ts —— 上下文合法化（仓库模块职责）
//
// 删除/修改（context_remove/context_edit = markInvalid/updateMessage）
// 可能破坏消息角色序列，导致经 gateway 发送非法。本函数对组装后的
// ChatMessage[] 做纯变换，保证输出可经 gateway 发送：
//   1. 悬空 tool_calls 裁剪：assistant 的 toolCalls 若无对应 tool 结果
//      → 剥掉该调用（全空则降级为纯文本 assistant）；
//   2. 孤儿 tool 剔除：tool 消息若其 toolCallId 无前置 assistant 声明
//      （调用已被裁剪）→ 丢弃（含无 toolCallId 的 tool 消息）；
//   3. tool→user 相邻修复：tool 后直接跟 user 对部分 provider 非法
//      → 插入空 assistant 边界占位。
//
// 纯变换，不改存储；组装 delivery 时统一过（单入口）。
// ============================================================

import type { ChatMessage } from '../gateway'

/** 合法化组装后的消息序列（保证可经 gateway 发送）。 */
export function legalize(messages: readonly ChatMessage[]): ChatMessage[] {
  // 1. 收集实际兑现的 toolCallId（存在对应 tool 结果）。
  const realized = new Set<string>()
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId !== undefined) realized.add(m.toolCallId)
  }

  // 2. 裁剪悬空 tool_calls（保留已兑现的调用）。
  const intermediate: ChatMessage[] = []
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls !== undefined && m.toolCalls.length > 0) {
      const kept = m.toolCalls.filter((tc) => realized.has(tc.id))
      if (kept.length === m.toolCalls.length) {
        intermediate.push(m)
      } else if (kept.length > 0) {
        intermediate.push({ ...m, toolCalls: kept })
      } else {
        intermediate.push({ ...m, toolCalls: undefined })
      }
    } else {
      intermediate.push(m)
    }
  }

  // 3. 剔除孤儿 tool 消息（调用已被裁剪 / 无 toolCallId）。
  const declared = new Set<string>()
  for (const m of intermediate) {
    if (m.role === 'assistant') for (const tc of m.toolCalls ?? []) declared.add(tc.id)
  }
  const pruned = intermediate.filter(
    (m) => !(m.role === 'tool' && m.toolCallId !== undefined && !declared.has(m.toolCallId)),
  )

  // 4. 修复 tool→user 相邻（插入空 assistant 边界）。
  const result: ChatMessage[] = []
  for (let i = 0; i < pruned.length; i++) {
    const msg = pruned[i]
    if (msg === undefined) continue
    result.push(msg)
    const next = pruned[i + 1]
    if (msg.role === 'tool' && next !== undefined && next.role === 'user') {
      result.push({ role: 'assistant', content: '' })
    }
  }
  return result
}