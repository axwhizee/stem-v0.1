// ============================================================
// core/context/stamp.ts —— 信件发送者戳（B4：时间 + 身份，一处收口）
//
// 形态：`<sender id="name#id" at="yymmdd.hhmm">正文</sender>`
//   - id 槽承载**全名**（呈现面统一 name#id，见 kernel/types.formatFull）；
//   - at 为信件入库时刻（分钟精度——秒位烧 token 且模型无秒级推理需求）；
//   - 打戳器唯一在 ContextManager.applyStamps，本文件只提供纯格式化口，
//     断言面全链共用（审计定律 §H-7：戳格式断言一处收口）。
// ============================================================

/** 戳前缀（幂等判定用：已打戳的 user 行不二次包装）。 */
export const SENDER_PREFIX = '<sender id='

/** epoch ms → `yymmdd.hhmm`（本地时区——信件是人类共读物）。 */
export function formatStampAt(ms: number): string {
  const d = new Date(ms)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}.${p(d.getHours())}${p(d.getMinutes())}`
}

/** 打戳（identity = `name#id` 全名；at = 入库时刻 ms）。 */
export function stampSender(identity: string, at: number, text: string): string {
  return `<sender id="${identity}" at="${formatStampAt(at)}">${text}</sender>`
}

/** 是否已带戳（原文以戳前缀开场的行不再二次包装）。 */
export function hasSenderStamp(text: string): boolean {
  return text.startsWith(SENDER_PREFIX)
}

/**
 * 解析发送者戳（读侧唯一入口，与 stampSender 同源）。
 * 兼容有/无 `at` 槽；无戳原文 → sender 空串、body 原样。
 */
export function parseStamp(text: string): { sender: string; at: string; body: string } {
  const match = /^<sender id="([^"]+)"(?: at="([^"]*)")?>([\s\S]*?)<\/sender>$/.exec(text)
  if (!match) return { sender: '', at: '', body: text }
  return { sender: match[1] ?? '', at: match[2] ?? '', body: match[3] ?? '' }
}

/** 剥 sender 戳取正文（无戳 = 原样）。 */
export function stripSenderStamp(text: string): string {
  return parseStamp(text).body
}
