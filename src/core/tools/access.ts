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
//   严格度**总序**（2026-09 裁决，取代旧偏序 {allow,ignore} 同级）：
//   deny ≺ ask ≺ allow ≺ ignore——按"监督度"排：ignore = 看不见的执行，
//   监督最弱 = 最宽；allow 暴露于清单可审；ask 有人审闸；deny 关闭。
//   继承/更新/物化一律顺链只许向右收缩（藏匿祖先 allow 是扩张，禁止）。
// ============================================================

import type { ToolAccess } from './types'

/**
 * 严格度总序：deny(0) ≺ ask(1) ≺ allow(2) ≺ ignore(3)，值小 = 更严。
 * ignore 最宽（隐藏但可执行、清单不可见）；allow→ignore 即扩张被拒。
 */
const RANK: Readonly<Record<ToolAccess, number>> = { deny: 0, ask: 1, allow: 2, ignore: 3 }

/** 取更严格者（单调收缩总序：任何一环收紧，结果收紧；无同级 tiebreak）。 */
export function restrictAccess(a: ToolAccess, b: ToolAccess): ToolAccess {
  return RANK[a]! <= RANK[b]! ? a : b
}
