// ============================================================
// extension/tools/skill/skill.ts —— SKILL.md 兼容工具（机制在 extension）
//
// 与常见 harness 同构：机制代码住 extension；技能内容住 stem 空间
// `.stem/skills/<名>/SKILL.md`（YAML 头 name/description + 正文）。
// init：发现并组装就绪态/描述；execute：列清单 / 按名取正文（渐进披露）。
// 无热插拔：清单只在 drain 期组装。
// ============================================================

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import type { ToolCapability, ToolInitContext } from '../../../src/core/tools'

interface SkillMeta {
  readonly name: string
  readonly description: string
  readonly body: string
  readonly dir: string
}

function parseSkill(text: string, fallbackName: string, dir: string): SkillMeta | undefined {
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
    dir,
  }
}

async function discoverSkills(initCtx: ToolInitContext | undefined): Promise<Map<string, SkillMeta>> {
  const skills = new Map<string, SkillMeta>()
  const root =
    initCtx?.projectRoot !== undefined
      ? join(initCtx.projectRoot, '.stem', 'skills')
      : join(process.cwd(), '.stem', 'skills')

  let names: readonly string[] = []
  if (initCtx?.fs !== undefined) {
    names = await initCtx.fs.listFiles(root).catch(() => [])
  } else {
    names = await readdir(root, { withFileTypes: true })
      .then((list) => list.filter((e) => e.isDirectory()).map((e) => e.name))
      .catch(() => [])
  }

  for (const name of names) {
    if (name.startsWith('_') || name.startsWith('.')) continue
    const dir = join(root, name)
    const file = join(dir, 'SKILL.md')
    let text: string | undefined
    if (initCtx?.fs !== undefined) {
      // listFiles 可能带路径前缀；也可能是目录名——两种都试。
      const candidates = [file, join(root, name, 'SKILL.md'), name.endsWith('.md') ? join(root, name) : '']
      for (const cand of candidates) {
        if (cand === '') continue
        text = await initCtx.fs.readText(cand).catch(() => undefined)
        if (text !== undefined) break
      }
    } else {
      text = await readFile(file, 'utf8').catch(() => undefined)
    }
    if (text === undefined) continue
    // 目录名探测：若 listFiles 返回的是文件路径，跳过非 SKILL.md
    if (typeof text === 'string' && text.startsWith('---') === false && !name.includes('SKILL')) {
      // 仍接受无 frontmatter 的失败解析
    }
    const meta = parseSkill(text, name.replace(/\.md$/, ''), dir)
    if (meta) skills.set(meta.name, meta)
  }
  return skills
}

/** 就绪态：init 一次快照。 */
let catalog: Map<string, SkillMeta> | undefined
let baseDescription =
  '加载外部 skill（SKILL.md 生态兼容）。无参数 = 列出已装载技能清单；传 name = 返回正文与附属目录。' +
  '清单在系统初始化时从 .stem/skills/ 预载。'

const skillTool: ToolCapability = {
  id: 'skill',
  get description() {
    return baseDescription
  },
  kind: 'extension',
  category: 'business',
  birth: 'ignore',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '技能名（来自清单；缺省 = 列清单）' },
    },
  },
  init: async (ctx) => {
    catalog = await discoverSkills(ctx)
    if (catalog.size > 0) {
      const names = [...catalog.values()].map((m) => m.name).join('、')
      baseDescription =
        `加载外部 skill（SKILL.md）。已装载 ${catalog.size} 个：${names}。` +
        '无参数 = 列清单；传 name = 取正文（渐进披露）。内容目录 .stem/skills/，无热插拔。'
    }
  },
  execute: async (input) => {
    const skills = catalog ?? new Map<string, SkillMeta>()
    const { name } = (input ?? {}) as { name?: string }
    if (name === undefined || name === '') {
      if (skills.size === 0) {
        return { text: '（本空间暂无已装载技能：在 .stem/skills/<技能名>/SKILL.md 落文件后重启即被识别——无热插拔）' }
      }
      const lines = [...skills.values()].map((m) => `- ${m.name}: ${m.description}`)
      return { text: `可用技能 ${skills.size} 个（skill({name}) 按需加载正文）：\n${lines.join('\n')}` }
    }
    const found = skills.get(name)
    if (!found) {
      const names = [...skills.keys()].join(', ') || '（空）'
      return { text: `技能不存在: ${name}。当前可用：${names}` }
    }
    return {
      text: `# Skill: ${found.name}\n\n${found.description}\n\n${found.body}\n\n（附属文件根目录：${found.dir}/，需要脚本/资源时用文件工具访问）`,
    }
  },
}

/** extension 入口可工厂形态（loader 注入 projectRoot）。 */
export default function createSkillTool(projectRoot?: string): ToolCapability {
  if (projectRoot !== undefined) {
    // 根路径写入模块级就绪态的发现锚点（init 仍会用 ToolInitContext 覆盖）。
    void projectRoot
  }
  return skillTool
}
