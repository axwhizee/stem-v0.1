// ============================================================
// src/core/types.ts —— 跨层公共类型（纯 TS，零平台依赖）
//
// 仅在多个 core 子模块（kernel / tools / context…）间共享的类型
// 放这里；单模块专属类型仍放各模块 types.ts。
// ============================================================

/** 权限分级（铁律 8 / D10）：normal=业务+对话；advanced=实例创建/调度；admin=类创建/全量日志。 */
export type PermissionLevel = 'normal' | 'advanced' | 'admin'

const PERMISSION_RANK: Record<PermissionLevel, number> = {
  normal: 0,
  advanced: 1,
  admin: 2,
}

/** 判断实际权限是否满足所需权限（actual ≥ required）。 */
export function hasPermission(actual: PermissionLevel, required: PermissionLevel): boolean {
  return PERMISSION_RANK[actual] >= PERMISSION_RANK[required]
}
