// ============================================================
// core/init/agentSerialize.ts —— agent 类序列化器（agentParse 的逆函数）
//
// 进化书写面的先决件（方案史见 docs/log.md S5.2 阶段与 git 史）：
// 类注册工具的落盘 = serializeAgentClass → `.stem/agent/<name>.md`。
//
// **往返律**（验收标准）：parse(serialize(cls), name) ≡ normalize(cls)
//   - name 恒取文件名（agentParse 不读 frontmatter 的 name，与写侧对齐）；
//   - description / tools 四态 Record / send_countdown / context_strategy /
//     model（"提供商/模型"）逐字段对齐；custom 原键值透传（undefined 值写侧
//     剔除——parse 侧 extra 不产 undefined，往返保持干净）；
//   - systemPrompt 为正文（extractPrompt 会 trim，测试输入按 trim 后比较）。
//
// **红线**（D6/D7）：
//   - `panel === true` 的模块扮演类（user0 根模板、策略 role 等）**永不回写**
//     ——系统机制类与用户主权基因分界，`.stem/agent/` 只装后者；
//   - 类名即文件名：字符集守卫（kebab/点/下划线，拒路径穿越）——模型可控
//     输入参与文件路径，必须在此收紧。
// ============================================================

import { stringify as stringifyYaml } from 'yaml'
import type { AgentClass } from '../kernel'

/** frontmatter 已知键（与 agentParse 的 KNOWN_KEYS 同步——custom 冲突校验共用）。 */
export const AGENT_KNOWN_KEYS: ReadonlySet<string> = new Set([
  'description',
  'tools',
  'send_countdown',
  'context_strategy',
  'model',
])

/** 类名字符集（= 文件名安全）：字母数字开头，允许字母数字 . _ -。 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 类名 → 落盘文件名（含注入守卫）。 */
export function agentFileName(name: string): string {
  if (!NAME_RE.test(name) || name.includes('..')) {
    throw new Error(`类名不可作为文件名落盘（仅允许字母数字与 . _ -，不得含路径分隔）：${JSON.stringify(name)}`)
  }
  return `${name}.md`
}

/** 目录 + 类名 → 文件路径（core 零平台依赖：不做平台 join，约定 '/' 拼接与 ConfigPaths 同源）。 */
export function agentFileOf(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${agentFileName(name)}`
}

/**
 * AgentClass → `.stem/agent/<name>.md` 全文（frontmatter + 正文）。
 * @throws panel 类回写（红线）/ custom 键与已知键冲突 / 类名非法。
 */
export function serializeAgentClass(cls: AgentClass): string {
  if (cls.panel === true) {
    throw new Error(`panel 类 ${cls.name} 为系统机制承载，永不回写 .stem/agent/（红线）`)
  }
  const head: Record<string, unknown> = {
    description: cls.description,
    tools: { ...cls.tools },
    ...(cls.sendCountdown !== undefined ? { send_countdown: cls.sendCountdown } : {}),
    ...(cls.contextStrategy !== undefined ? { context_strategy: cls.contextStrategy } : {}),
    ...(cls.model !== undefined ? { model: `${cls.model.provider}/${cls.model.id}` } : {}),
  }
  // custom 自由键透传（进化基因承载位）：与已知键冲突 = 歧义，拒绝落盘；undefined 值剔除。
  for (const [key, value] of Object.entries(cls.custom ?? {})) {
    if (AGENT_KNOWN_KEYS.has(key)) {
      throw new Error(`custom 键 "${key}" 与 frontmatter 已知键冲突，无法无损往返（请改用标准字段）`)
    }
    if (value === undefined) continue
    head[key] = value
  }
  const yaml = stringifyYaml(head)
  return `---\n${yaml}---\n\n${cls.systemPrompt}\n`
}
