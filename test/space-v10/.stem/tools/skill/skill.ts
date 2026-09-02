// ============================================================
// .stem/tools/skill/skill.ts —— SKILL.md 兼容装载器（S7 路 A：零系统 skill 机制）
//
// 系统 core 不再有 skill 子系统；本工具是**普通 custom 工具**（目录形态约定的
// 示范：入口 skill.ts + 技能资产 <名>/SKILL.md 同目录自由放置）。
//
// 用法约定（渐进披露保留）：
//   skill()          → 列出本目录全部技能的 name/description 清单
//   skill({name})    → 返回该技能正文 + 附属文件根路径（脚本经 fs/bash 工具触达）
//
// SKILL.md 格式与 opencode/claude 生态兼容（--- 包 YAML 头：name/description + 正文）。
// 另一条路（无代码）：让 LLM 把 SKILL.md 手动转化为真工具（.stem/tools/<名>/<名>.ts）
// 或折叠进类 systemPrompt——见 docs/dev-guide.md 使用模式。
// ============================================================

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import type { ToolCapability } from '../../../../src/core/tools'

/** 技能资产根 = 本文件所在目录（`.stem/tools/skill/`）。 */
const SKILL_ROOT = new URL('.', import.meta.url).pathname

interface SkillMeta {
  readonly name: string
  readonly description: string
  readonly body: string
}

/** SKILL.md → meta（YAML 头 name/description；正文为 body）。解析失败 = undefined。 */
function parseSkill(text: string, fallbackName: string): SkillMeta | undefined {
  const match = /^---\r?\n([\s\S]*?)(?:\r?\n)?---(?:\r?\n|$)([\s\S]*)$/.exec(text)
  if (!match) return undefined
  let head: Record<string, unknown> = {}
  try {
    head = (parseYaml(match[1] ?? '') as Record<string, unknown> | null) ?? {}
  } catch {
    return undefined
  }
  const name = typeof head.name === 'string' && head.name !== '' ? head.name : fallbackName
  return {
    name,
    description: typeof head.description === 'string' ? head.description : '',
    body: (match[2] ?? '').trim(),
  }
}

async function discoverSkills(): Promise<Map<string, { meta: SkillMeta; dir: string }>> {
  const skills = new Map<string, { meta: SkillMeta; dir: string }>()
  const entries = await readdir(SKILL_ROOT, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue
    const dir = join(SKILL_ROOT, e.name)
    const text = await readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => undefined)
    if (text === undefined) continue // 普通资源目录，非技能包。
    const meta = parseSkill(text, e.name)
    if (meta) skills.set(meta.name, { meta, dir })
  }
  return skills
}

const skillCompatTool: ToolCapability = {
  id: 'skill',
  description:
    '加载外部 skill（SKILL.md 生态兼容）。无参数 = 列出本空间 .stem/tools/skill/ 下全部技能清单（name/description）；' +
    '传 name = 返回该技能完整正文与附属文件目录。渐进披露：正文只在需要时进入上下文。',
  kind: 'custom',
  category: 'business',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '技能名（来自清单；缺省 = 列清单）' },
    },
  },
  execute: async (input) => {
    const { name } = (input ?? {}) as { name?: string }
    const skills = await discoverSkills()
    if (name === undefined || name === '') {
      if (skills.size === 0) return { text: '（本空间暂无技能：在 .stem/tools/skill/<技能名>/SKILL.md 落文件即被识别）' }
      const lines = [...skills.values()].map(({ meta }) => `- ${meta.name}: ${meta.description}`)
      return { text: `可用技能 ${skills.size} 个（skill({name}) 按需加载正文）：\n${lines.join('\n')}` }
    }
    const found = skills.get(name)
    if (!found) {
      const names = [...skills.keys()].join(', ') || '（空）'
      return { text: `技能不存在: ${name}。当前可用：${names}` }
    }
    return {
      text: `# Skill: ${found.meta.name}\n\n${found.meta.description}\n\n${found.meta.body}\n\n（附属文件根目录：${found.dir}/，需要脚本/资源时用文件工具访问）`,
    }
  },
}

export default skillCompatTool
