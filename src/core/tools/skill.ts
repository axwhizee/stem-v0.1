// ============================================================
// core/tools/skill.ts —— skill 工具（core 生态，与 bash 同级）
//
// skill = 渐进式披露载体：system 只注入 <available_skills> 清单
// （name/description），正文经本工具按需懒加载进上下文——
// 承载相似工具组的 schema 与用法，避免大量工具上下文膨胀。
//
// 发现走工具初始化生命周期：`init(ctx)` 扫描 ctx.skillDir 下的
// SKILL.md（YAML 头 name/description + 正文），注册进 SkillRegistry。
// 暴露靠类配置（internal 默认 ignore，模板显式 `skill: allow`）。
// ============================================================

import { parse as parseYaml } from 'yaml'
import type { SkillInfo, SkillRegistry } from './SkillRegistry'
import type { ToolCapability, ToolInitContext } from './types'

/** skill 文件解析（SKILL.md：`---` YAML 头 + 正文）。 */
export function parseSkillFile(text: string, filename: string): SkillInfo {
  const fail = (message: string): never => {
    throw new Error(`skill 文件 ${filename} frontmatter 非法：${message}`)
  }
  const match = /^---\r?\n([\s\S]*?)(?:\r?\n)?---(?:\r?\n|$)/.exec(text)
  if (!match) fail('缺少 --- 包裹的 YAML frontmatter')
  const head = parseYaml(match?.[1] ?? '')
  // 空 YAML 头 → 空对象（对齐 agentParse 行为）。
  if (head !== null && head !== undefined && (typeof head !== 'object' || Array.isArray(head))) {
    fail('frontmatter 必须是对象')
  }
  const raw = (head === null || head === undefined ? {} : head) as Record<string, unknown>
  const name = typeof raw.name === 'string' && raw.name !== '' ? raw.name : filename.replace(/\.md$/, '')
  const description = typeof raw.description === 'string' ? raw.description : ''
  const bodyMatch = /^---\r?\n[\s\S]*?(?:\r?\n)?---(?:\r?\n|$)([\s\S]*)$/.exec(text)
  const body = (bodyMatch?.[1] ?? '').trim()
  if (body === '') fail(`skill ${name} 正文为空`)
  return { name, description, body, file: filename }
}

/** 构造 skill 工具（依赖注入 SkillRegistry，注册表由系统装配创建）。 */
export function createSkillTool(deps: { skills: SkillRegistry }): ToolCapability {
  return {
    id: 'skill',
    description:
      '加载指定 skill 的完整正文到上下文。skill 清单见 system 提示词的 <available_skills>（只有 name/description）；需要其详细 schema 与用法时用本工具按名加载正文。',
    kind: 'internal',
    category: 'skill',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'skill 名称（来自 <available_skills> 清单）' } },
      required: ['name'],
    },
    init: async (ctx: ToolInitContext): Promise<void> => {
      if (!ctx.fs || !ctx.skillDir) return
      await scanSkillDir(ctx.fs, ctx.skillDir, deps.skills)
    },
    execute: async (input) => {
      const name = (input as { name: string }).name
      const skill = deps.skills.get(name)
      if (!skill) {
        throw {
          kind: 'execution_failed',
          tool: 'skill',
          message: `skill 不存在: ${name}（可用清单见 <available_skills>）`,
        }
      }
      return { text: `# Skill: ${skill.name}\n\n${skill.description}\n\n${skill.body}` }
    },
  }
}

async function scanSkillDir(
  fs: import('./types').ToolInitFs,
  dir: string,
  registry: SkillRegistry,
): Promise<void> {
  const files = await fs.listFiles(dir)
  for (const file of files) {
    if (!file.endsWith('.md')) continue
    const text = await fs.readText(`${dir}/${file}`)
    try {
      registry.register(parseSkillFile(text, file))
    } catch {
      // 非法 skill 文件：init 阶段不致命，跳过。
    }
  }
}