// ============================================================
// extension/tools/skill/skill.ts —— SKILL.md 兼容工具（机制在 extension）
//
// 与常见 harness 同构：机制代码住 extension；技能内容住 stem 空间
// `.stem/skills/<名>/SKILL.md`（YAML 头 name/description + 正文）。
// 工厂每次调用产出独立 ToolCapability（就绪态闭包自持，无模块级共享）。
// init：发现并组装描述；execute：列清单 / 按名取正文。
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

async function discoverSkills(root: string, initCtx: ToolInitContext | undefined): Promise<Map<string, SkillMeta>> {
  const skills = new Map<string, SkillMeta>()
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
    const base = name.replace(/\.md$/, '')
    const dir = join(root, base)
    const file = join(dir, 'SKILL.md')
    let text: string | undefined
    if (initCtx?.fs !== undefined) {
      text =
        (await initCtx.fs.readText(file).catch(() => undefined)) ??
        (await initCtx.fs.readText(join(root, name)).catch(() => undefined))
    } else {
      text = await readFile(file, 'utf8').catch(() => undefined)
    }
    if (text === undefined) continue
    const meta = parseSkill(text, base, dir)
    if (meta) skills.set(meta.name, meta)
  }
  return skills
}

const BASE_DESC =
  '加载外部 skill（SKILL.md 生态兼容）。无参数 = 列出已装载技能清单；传 name = 返回正文与附属目录。' +
  '清单在系统初始化时从 .stem/skills/ 预载（无热插拔）。'

/** extension 入口：每次调用产出独立工具实例（就绪态闭包自持）。 */
export default function createSkillTool(projectRoot?: string): ToolCapability {
  let catalog = new Map<string, SkillMeta>()
  let description = BASE_DESC
  return {
    id: 'skill',
    get description() {
      return description
    },
    kind: 'extension',
    category: 'business',
    registerAccess: 'ignore',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名（来自清单；缺省 = 列清单）' },
      },
    },
    init: async (ctx) => {
      const base = ctx.projectRoot ?? projectRoot ?? process.cwd()
      const root = join(base, '.stem', 'skills')
      catalog = await discoverSkills(root, ctx)
      if (catalog.size > 0) {
        const names = [...catalog.values()].map((m) => m.name).join('、')
        description =
          `加载外部 skill（SKILL.md）。已装载 ${catalog.size} 个：${names}。` +
          '无参数 = 列清单；传 name = 取正文。内容目录 .stem/skills/。'
      }
    },
    execute: async (input) => {
      const { name } = (input ?? {}) as { name?: string }
      if (name === undefined || name === '') {
        if (catalog.size === 0) {
          return { text: '（本空间暂无已装载技能：在 .stem/skills/<技能名>/SKILL.md 落文件后重启即被识别——无热插拔）' }
        }
        const lines = [...catalog.values()].map((m) => `- ${m.name}: ${m.description}`)
        return { text: `可用技能 ${catalog.size} 个（skill({name}) 按需加载正文）：\n${lines.join('\n')}` }
      }
      const found = catalog.get(name)
      if (!found) {
        const names = [...catalog.keys()].join(', ') || '（空）'
        return { text: `技能不存在: ${name}。当前可用：${names}` }
      }
      return {
        text: `# Skill: ${found.name}\n\n${found.description}\n\n${found.body}\n\n（附属文件根目录：${found.dir}/，需要脚本/资源时用文件工具访问）`,
      }
    },
  }
}
