// ============================================================
// shell/tools/glob.ts —— glob 工具（kind=shell，权限 glob）
//
// 参考 opencode glob：按 glob 模式递归匹配文件路径
// （支持 ** / * / ? / {a,b}），返回匹配文件列表。
// ============================================================

import type { ToolCapability } from '../../../src/core/tools'
import { globToRegExp, inspect, resolvePath, walkTextFiles } from './fs-util'

export function createGlobTool(root: string): ToolCapability {
  return {
    id: 'glob',
    description: '按 glob 模式递归匹配文件路径（支持 ** / * / ? / {a,b}），返回匹配文件列表。',
    accessKey: 'glob',
    kind: 'shell',
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
      const matched = files.filter((f) => regex.test(f)).slice(0, limit)

      if (matched.length === 0) return { text: '未找到匹配文件' }
      return { text: `找到 ${matched.length} 个文件:\n${matched.join('\n')}` }
    },
  }
}
