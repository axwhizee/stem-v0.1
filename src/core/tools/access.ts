// ============================================================
// core/tools/access.ts —— 工具访问四态（ToolAccess）纯代数
//
// 权限融合进 tools 后的状态定义与严格度偏序。分层收敛/白名单物化
// 已迁往 lineage/AccessLedger（族谱权限台账，生效权限 = 族谱位置的函数）；
// 本模块只保留被台账与 tools 双方共享的**无状态纯函数**：
//   四态：allow  暴露 + 直接执行
//         ask    暴露 + 执行时挂起（投递申请到族谱根信箱）
//         deny   不暴露 + 拒绝（链上显式 deny = 不可豁免的铁律）
//         ignore 不暴露（默认隐藏）+ 等同 allow（隐藏的 allow）
//   偏序（单调收缩用）：deny ≺ ask ≺ {allow, ignore}。
//   allow/ignore 同级（执行等价、可见性不同）——合并时同级由调用方
//   决定归属（台账规则：自身值优先，可见性自决）。
// ============================================================

import type { ToolAccess } from './types'

/**
 * 动作偏序下的严格度比较：deny < ask < {allow, ignore}。
 * ignore 与 allow 同级（ignore 是隐藏的 allow）。
 */
const RANK: Readonly<Record<ToolAccess, number>> = { deny: 0, ask: 1, allow: 2, ignore: 2 }

/** 取更严格者（单调收缩：任何一环收紧，结果收紧；同级取第一个参数）。 */
export function restrictAccess(a: ToolAccess, b: ToolAccess): ToolAccess {
  return RANK[a]! <= RANK[b]! ? a : b
}
