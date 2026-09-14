// ============================================================
// core/context/stamp.test.ts —— 信件戳代数（B4/§H-7：格式断言一处收口）
// ============================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatStampAt, hasSenderStamp, stampSender } from './stamp'

test('formatStampAt：yymmdd.hhmm 分钟精度（本地历法逐段补零）', () => {
  // 固定时刻跨时区安全：只断形制 + 从格式化结果反推分量单调。
  const a = formatStampAt(new Date(2026, 8, 7, 0, 39).getTime())
  assert.equal(a, '260907.0039')
  const b = formatStampAt(new Date(2026, 11, 31, 23, 59).getTime())
  assert.equal(b, '261231.2359')
  assert.match(formatStampAt(Date.now()), /^\d{6}\.\d{4}$/)
})

test('stampSender：全名 + 时刻 + 正文包裹；幂等判定在场', () => {
  const t = stampSender('worker-2#1', new Date(2026, 8, 7, 0, 39).getTime(), '在吗')
  assert.equal(t, '<sender id="worker-2#1" at="260907.0039">在吗</sender>')
  assert.ok(hasSenderStamp(t))
  assert.ok(!hasSenderStamp('裸文本'))
})
