// ============================================================
// core/tools/output.ts —— 工具输出统一成形（成功与错误同一入口）
//
// 结果落上下文前的唯一成形点：`formatToolOutput(result | error, opts)`。
// 消除 runtime 会话回填与工具记录 sink 两处重复的错误渲染/窗口裁剪逻辑。
//
// 窗口限制：`config.tools.outputLimit`（字符口径）；0/未设 = 不启用
//（默认零行为变更）。超限时头部截断 + 省略说明（工具输出通常前段更有信息量）。
// ============================================================

import type { ToolError, ToolResult } from './types'
import { isToolError } from './types'

/**
 * 任意错误 → 可日志投影（halt/forget 共用）。
 * 结构化对象保留 kind；Error 取 message；其余 String()——杜绝 `[object Object]`。
 */
export function errorBrief(cause: unknown): { readonly kind?: string; readonly message: string } {
  if (cause instanceof Error) return { message: cause.message }
  if (cause !== null && typeof cause === 'object') {
    const o = cause as { kind?: unknown; message?: unknown }
    const message = typeof o.message === 'string' && o.message !== '' ? o.message : JSON.stringify(cause)
    return typeof o.kind === 'string' ? { kind: o.kind, message } : { message }
  }
  return { message: String(cause) }
}

/** 输出成形选项（来自 `config.tools`）。 */
export interface ToolOutputOptions {
  /** 字符上限；0/未设 = 不启用。 */
  readonly outputLimit?: number
}

/**
 * 工具输出成形唯一入口：成功与失败同走此处。
 * @param input 成功结果（ToolResult）或判别联合错误（ToolError）
 */
export function formatToolOutput(input: ToolResult | ToolError, opts: ToolOutputOptions = {}): string {
  const text = isToolError(input) ? formatToolError(input) : (input as ToolResult).text
  return clip(text, opts.outputLimit)
}

/** 工具错误 → 可行动文本（kind 必显示；细节优先 message/feedback，退化为访问键/工具名）。 */
export function formatToolError(error: ToolError): string {
  const detail =
    'message' in error && typeof error.message === 'string' && error.message !== ''
      ? error.message
      : 'feedback' in error && typeof error.feedback === 'string' && error.feedback !== ''
        ? error.feedback
        : 'accessKey' in error && typeof error.accessKey === 'string'
          ? `访问键 ${error.accessKey} 被拒`
          : 'tool' in error && typeof error.tool === 'string' && error.tool !== ''
            ? `工具 ${error.tool}`
            : ''
  return detail !== '' ? `[ToolError ${error.kind}] ${detail}` : `[ToolError ${error.kind}] 工具执行失败`
}

/** 头部截断（保留前段 + 省略标记）。 */
function clip(text: string, limit?: number): string {
  if (limit === undefined || limit <= 0 || text.length <= limit) return text
  return `${text.slice(0, limit)}\n…（输出超上限 ${String(limit)} 字符，已截断 ${String(text.length - limit)} 字符）`
}
