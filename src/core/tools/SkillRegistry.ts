// ============================================================
// core/tools/SkillRegistry.ts —— skill 注册表（core 生态工具）
//
// skill 与 bash 同级（普通工具，经类配置显式暴露），发现走工具
// 初始化生命周期（skill 工具的 init 扫描 `.stem/skills/`）：
//   - 注册表（本文件）：纯 Map 存储 name/description/body；
//   - skill 工具（skill.ts）：init 扫描注册 + execute 懒加载正文；
//   - 清单注入：上下文组装时从本注册表读 <available_skills>（见 context）。
// ============================================================

/** skill 信息（SKILL.md：YAML 头 name/description + 正文）。 */
export interface SkillInfo {
  readonly name: string
  readonly description: string
  /** 完整正文（懒加载时进入上下文）。 */
  readonly body: string
  /** 来源文件（相对 skill 目录）。 */
  readonly file?: string
}

export interface SkillRegistry {
  readonly register: (skill: SkillInfo) => void
  readonly unregister: (name: string) => void
  readonly get: (name: string) => SkillInfo | undefined
  readonly list: () => readonly SkillInfo[]
  /** `<available_skills>` 清单（供 system 注入；空则返回空串）。 */
  readonly manifest: () => string
}

/** 注册错误（判别联合）。 */
export type SkillError = { readonly kind: 'skill_conflict'; readonly name: string }

export class DefaultSkillRegistry implements SkillRegistry {
  private readonly skills = new Map<string, SkillInfo>()

  register(skill: SkillInfo): void {
    if (this.skills.has(skill.name)) {
      throw { kind: 'skill_conflict', name: skill.name } satisfies SkillError
    }
    this.skills.set(skill.name, skill)
  }

  unregister(name: string): void {
    this.skills.delete(name)
  }

  get(name: string): SkillInfo | undefined {
    return this.skills.get(name)
  }

  list(): readonly SkillInfo[] {
    return [...this.skills.values()]
  }

  manifest(): string {
    if (this.skills.size === 0) return ''
    const items = [...this.skills.values()]
      .map(
        (s) =>
          `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>` +
          (s.file !== undefined ? `\n    <location>${s.file}</location>` : '') +
          `\n  </skill>`,
      )
      .join('\n')
    return `<available_skills>\n${items}\n</available_skills>`
  }
}