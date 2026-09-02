// ============================================================
// extension/tools/grep.ts —— grep 工具（kind=extension，权限 grep）
//
// 参考 opencode grep：按正则递归搜索文本文件（排除 .git /
// node_modules），返回 file:line:text。pattern 为完整正则。
// ============================================================

import { readFile } from 'node:fs/promises'
import type { ToolCapability } from '../../../src/core/tools'
import { globToRegExp, inspect, isBinary, matchGlobPath, resolvePath, walkTextFiles } from '../_lib/fs-util'

export interface GrepMatch {
  readonly path: string
  readonly line: number
  readonly text: string
}

export function createGrepTool(root: string): ToolCapability {
  return {
    id: 'grep',
    description: '按正则表达式递归搜索文件内容（排除 .git / node_modules），返回 file:line:text。支持 include 按 glob 过滤文件。',
    accessKey: 'grep',
    kind: 'extension',
    category: 'business',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        path: { type: 'string', description: '搜索目录（绝对或相对工作区，缺省=工作区根）' },
        include: { type: 'string', description: '按 glob 过滤文件（如 *.ts、*.{ts,tsx}）' },
        limit: { type: 'number', description: '最大匹配数（缺省 100）' },
      },
      required: ['pattern'],
    },
    execute: async (input) => {
      const { pattern, path, include, limit = 100 } = input as { pattern: string; path?: string; include?: string; limit?: number }
      let regex: RegExp
      try {
        regex = new RegExp(pattern)
      } catch (error) {
        return { text: `非法正则: ${error instanceof Error ? error.message : String(error)}` }
      }

      const dir = path !== undefined ? resolvePath(root, path) : root
      const info = await inspect(dir)
      if (!info || !info.isDirectory) return { text: `搜索目录不可用: ${dir}` }

      const files = await walkTextFiles(dir)
      const includeRe = include !== undefined ? globToRegExp(include) : undefined
      const matches: GrepMatch[] = []
      for (const file of files) {
        if (matches.length >= limit) break
        if (includeRe && !matchGlobPath(includeRe, dir, file)) continue
        let buffer: Buffer
        try {
          buffer = await readFile(file)
        } catch {
          continue
        }
        if (isBinary(buffer)) continue
        const text = buffer.toString('utf8')
        const lines = text.split('\n')
        for (let i = 0; i < lines.length && matches.length < limit; i++) {
          if (regex.test(lines[i]!)) {
            matches.push({ path: file, line: i + 1, text: lines[i]!.slice(0, 200) })
            regex.lastIndex = 0
          }
        }
      }

      if (matches.length === 0) return { text: '未找到匹配' }
      const byFile = new Map<string, GrepMatch[]>()
      for (const m of matches) {
        const list = byFile.get(m.path) ?? []
        list.push(m)
        byFile.set(m.path, list)
      }
      const text = [...byFile.entries()]
        .map(([file, list]) => `${file}:\n` + list.map((m) => `  ${m.line}: ${m.text}`).join('\n'))
        .join('\n')
      return { text: `找到 ${matches.length} 处匹配:\n${text}` }
    },
  }
}

/** Extension matrix entry (factory form): loader injects projectRoot → tool instance. */
export default createGrepTool
