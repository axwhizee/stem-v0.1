// ============================================================
// core/tools/access.ts —— 工具访问（ToolAccess）评估纯函数
//
// 权限模块融合进 tools 后的评估层。四态：
//   allow  暴露 + 直接执行
//   ask    暴露 + 执行时挂起弹窗
//   deny   不暴露 + 拒绝
//   ignore 不暴露（默认隐藏）+ 等同 allow（显式声明为 allow 后暴露）
//
// 偏序（单调收缩/继承用）：deny ≺ ask ≺ {allow, ignore}（allow≈ignore 同级）。
// 分层评估：agent 生效访问 = 逐层取更严格（restrictAccess），
//   即「单向收缩」：全局(最弱) → 祖先链 → agent 类 → session 批准。
// ============================================================

import type { ToolAccess, ToolAccessRules } from './types'

/**
 * 动作偏序下的严格度比较：deny < ask < {allow, ignore}。
 * ignore 与 allow 同级（ignore 是隐藏的 allow）。
 */
const RANK: Readonly<Record<ToolAccess, number>> = { deny: 0, ask: 1, allow: 2, ignore: 2 }

/** 取更严格者（单调收缩：任何一环收紧，全局收紧；拒绝不可被后序撤销）。 */
export function restrictAccess(a: ToolAccess, b: ToolAccess): ToolAccess {
  return RANK[a]! <= RANK[b]! ? a : b
}

/** 在单层规则集内求某访问键的动作（层内最后命中优先；缺省返回 undefined）。 */
export function accessInLayer(key: string, rules: ToolAccessRules | undefined): ToolAccess | undefined {
  if (!rules) return undefined
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]
    if (rule !== undefined && rule.key === key) return rule.action
  }
  return undefined
}

/**
 * 分层评估：对多层规则集逐层取命中值，层间取更严格。
 * 默认值（defaultAccess，如 internal 的 'ignore' 或普通 'ask'）**只作为
 * 无任何命中时的兜底**，不参与 restrict —— 否则默认 'ignore' 会吞掉
 * 显式 'allow'（两者同级）。
 * 调用方按「全局 → 祖先链(父→子) → agent 类 → session 批准」顺序传 layers，
 * 越靠后的层越「局部/强」——最终结果 = 全部命中层里最严格者，或默认值。
 */
export function evaluateAccess(
  key: string,
  layers: readonly (ToolAccessRules | undefined)[],
  defaultAccess: ToolAccess = 'ask',
): ToolAccess {
  let result: ToolAccess | undefined
  for (const layer of layers) {
    const hit = accessInLayer(key, layer)
    if (hit !== undefined) {
      result = result === undefined ? hit : restrictAccess(result, hit)
    }
  }
  return result ?? defaultAccess
}

/** 将 Record<访问键, ToolAccess>（AgentClass.toolAccess / 全局配置）转换为规则数组。 */
export function toolAccessToRules(access: Readonly<Record<string, ToolAccess>> | undefined): ToolAccessRules {
  return Object.entries(access ?? {}).map(([key, action]) => ({ key, action }))
}

/**
 * 祖先链权限收集：对祖先 id 列表（父 → … → 根）逐层提取访问规则。
 * 越靠前越「局部/强」；与 evaluateAccess 的层间单调收缩配合，
 * 构成「全局 → 祖先链 → agent 类 → session」的完整分层。
 */
export function collectAncestorAccessLayers(
  ancestors: readonly string[],
  accessLayerOf: (agentId: string) => ToolAccessRules | undefined,
): readonly ToolAccessRules[] {
  const layers: ToolAccessRules[] = []
  for (const id of ancestors) {
    const layer = accessLayerOf(id)
    if (layer !== undefined) layers.push(layer)
  }
  return layers
}
