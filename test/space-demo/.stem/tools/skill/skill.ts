// ============================================================
// .stem/tools/skill/skill.ts —— SKILL.md 兼容装载器（S7 路 A：零系统 skill 机制）
//
// 系统 core 不再有 skill 子系统；本工具是**普通 custom 工具**（目录形态约定的
// 示范：入口 skill.ts + 技能资产 <名>/SKILL.md 同目录自由放置）。
//
// 生命周期（无热插拔）：
//   init    —— 装配期扫本目录，建 name/description 索引（就绪态）
//   execute —— 只读缓存：列清单 / 按名取正文；运行期不重扫空间
//
// SKILL.md 格式与 opencode/claude 生态兼容（--- 包 YAML 头：name/description + 正文）。
// 另一条路（无代码）：让 LLM 把 SKILL.md 手动转化为真工具（.stem/tools/<名>/<名>.ts）
// 或折叠进类 systemPrompt——见 docs/dev-guide.md 使用模式。
// ============================================================

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import type { ToolCapability, ToolInitContext } from '../../../../src/core/tools'

interface SkillMeta {
  readonly name: string
  readonly description: string
  readonly body: string
  readonly dir: string
}

/** SKILL.md → meta（YAML 头 name/description；正文为 body）。解析失败 = undefined。 */
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

/**
 * 装配期预载（init 专用）。优先用注入的 ToolInitFs（core 契约）；
 * 缺省回落 node:fs（shell 宿主装载 custom 工具的常态路径）。
 * 失败 fail-soft：空表，不拒启。
 */
async function discoverSkills(initCtx: ToolInitContext | undefined): Promise<Map<string, SkillMeta>> {
  const skills = new Map<string, SkillMeta>()
  const root = initCtx?.projectRoot !== undefined
    ? join(initCtx.projectRoot, '.stem', 'tools', 'skill')
    : new URL('.', import.meta.url).pathname

  let entries: readonly string[]
  if (initCtx?.fs !== undefined) {
    entries = await initCtx.fs.listFiles(root).catch(() => [])
  } else {
    entries = await readdir(root, { withFileTypes: true })
      .then((list) => list.filter((e) => e.isDirectory()).map((e) => e.name))
      .catch(() => [])
  }

  for (const name of entries) {
    if (name.startsWith('_') || name.startsWith('.')) continue
    const dir = join(root, name)
    const file = join(dir, 'SKILL.md')
    let text: string | undefined
    if (initCtx?.fs !== undefined) {
      text = await initCtx.fs.readText(file).catch(() => undefined)
    } else {
      text = await readFile(file, 'utf8').catch(() => undefined)
    }
    if (text === undefined) continue
    const meta = parseSkill(text, name, dir)
    if (meta) skills.set(meta.name, meta)
  }
  return skills
}

/** 就绪态：init 一次快照；execute 只读（无热插拔）。 */
let catalog: Map<string, SkillMeta> | undefined

const skillCompatTool: ToolCapability = {
  id: 'skill',
  description:
    '加载外部 skill（SKILL.md 生态兼容）。无参数 = 列出已装载技能清单（name/description）；' +
    '传 name = 返回该技能完整正文与附属文件目录。渐进披露：正文只在需要时进入上下文。' +
    '清单在系统初始化时从 .stem/tools/skill/ 预载，运行期不重扫。',
  kind: 'custom',
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
  },
  execute: async (input) => {
    const skills = catalog ?? new Map<string, SkillMeta>()
    const { name } = (input ?? {}) as { name?: string }
    if (name === undefined || name === '') {
      if (skills.size === 0) {
        return { text: '（本空间暂无已装载技能：在 .stem/tools/skill/<技能名>/SKILL.md 落文件后重启即被识别——无热插拔）' }
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

export default skillCompatTool
