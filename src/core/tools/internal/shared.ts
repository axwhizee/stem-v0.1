// ============================================================
// core/tools/internal/shared.ts —— internal 工具共享基元
//
// 注册即出生声明；消费方拥有端口（./ports），零 kernel import。
// ============================================================

import type { ToolCapability, ToolAccess } from '../types'
import type { SystemToolHost, AgentConfigView } from './ports'
import type { ModelRef } from '../../gateway'
import { parseModelRef } from '../../gateway'

export function resolveOr(host: SystemToolHost, ref: string): { id: string } | { text: string } {
  try {
    return { id: host.agents.resolveAgent(ref) }
  } catch (e) {
    const err = e as { kind?: string; ref?: string; candidates?: readonly string[] }
    if (err?.kind === 'agent_ref_ambiguous') {
      return { text: `寻址歧义 "${err.ref ?? ref}"（id 前缀命中多活体）：候选 ${[...(err.candidates ?? [])].join(' , ')}——用 name 或 name#id 精确制导` }
    }
    return { text: `目标不存在（可用 name / name#id / id 寻址；mail_participants 可查在册全名）: ${ref}` }
  }
}

/** 三形态寻址 + 可见域门禁（缺省目标 = 调用者自身）。 */
export function resolveReachable(
  host: SystemToolHost,
  callerId: string,
  ref: string | undefined,
  denied: (id: string) => string,
): { id: string } | { text: string } {
  const resolved = ref !== undefined ? resolveOr(host, ref) : { id: callerId }
  if ('text' in resolved) return resolved
  if (!host.agents.canReach(callerId, resolved.id)) {
    return { text: denied(resolved.id) }
  }
  return resolved
}


export function parseModelArg(value: string): ModelRef | undefined {
  return parseModelRef(value)
}

export const MODEL_FORMAT_HINT = 'model 必须是 "提供商/模型" 格式（提供商 = config providers 注册表的键；裸模型名无归属不受理）'

/** 模型解析命中层的中文谱系标签（agent_inspect 出示；R6 四级律）。 */
export const MODEL_ORIGIN_LABELS: Record<string, string> = {
  explicit: '实例显式（出生指定或 set_model 改写）',
  class: '类基因',
  inherited: '父继承',
  home: '家学 = config.user.model',
}

/** 列出 agent 类。 */

export function formatEffectiveAccess(profile: AgentConfigView['access']): string {
  if (!profile) return '（未绑定）'
  const entries = Object.entries(profile.explicit).map(([k, v]) => `${k}:${v}`)
  const fallback = profile.fallback !== undefined ? `*: ${profile.fallback}` : '*: default'
  return entries.length > 0 ? `${entries.join(', ')}  |  ${fallback}` : fallback
}
