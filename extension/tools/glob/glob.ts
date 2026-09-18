// ============================================================
// extension/tools/glob.ts —— glob 工具（kind=extension，权限 glob）
//
// 参考 opencode glob：按 glob 模式递归匹配文件路径
// （支持 ** / * / ? / {a,b}），返回匹配文件列表。
// ============================================================

import type { ToolCapability } from '../../../src/core/tools'
import { globToRegExp, inspect, matchGlobPath, resolvePath, walkTextFiles } from '../_lib/fs-util'

export function createGlobTool(root: string): ToolCapability {
  return {
    id: 'glob',
    description: '按 glob 模式递归匹配文件路径（支持 ** / * / ? / {a,b}），返回匹配文件列表。',
    accessKey: 'glob',
    kind: 'extension',
    registerAccess: 'allow', // 自述推荐值；实际注册声明以 config.extensions.tools 点名权限词为准
    category: 'business',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式（如 **/*.ts、src/**/*.json）' },
        path: { type: 'string', description: '搜索目录（绝对或相对工作区，缺省=工作区根）' },
        limit: { type: 'number', description: '最大结果数（缺省 100）' },
      },
      required: ['pattern'],
    },
    execute: async (input) => {
      const { pattern, path, limit = 100 } = input as { pattern: string; path?: string; limit?: number }
      const dir = path !== undefined ? resolvePath(root, path) : root
      const info = await inspect(dir)
      if (!info || !info.isDirectory) return { text: `搜索目录不可用: ${dir}` }

      const regex = globToRegExp(pattern)
      const files = await walkTextFiles(dir)
      const matched = files.filter((f) => matchGlobPath(regex, dir, f)).slice(0, limit)

      if (matched.length === 0) return { text: '未找到匹配文件' }
      return { text: `找到 ${matched.length} 个文件:\n${matched.join('\n')}` }
    },
  }
}

/** Extension matrix entry (factory form): loader injects projectRoot → tool instance. */
export default createGlobTool
