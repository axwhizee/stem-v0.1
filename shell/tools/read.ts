// ============================================================
// shell/tools/read.ts —— read 工具（kind=shell，权限 read）
//
// 参考 opencode read：读取文本文件（offset/limit 分页，1-based
// 起始行，limit ≤2000）或列出目录；二进制文件拒绝文本读取。
// ============================================================

import { readdir } from 'node:fs/promises'
import type { ToolCapability } from '../../src/core/tools'
import { inspect, isBinary, resolvePath } from './fs-util'

const MAX_READ_LINES = 2000
const MAX_READ_BYTES = 50 * 1024

export function createReadTool(root: string): ToolCapability {
  return {
    id: 'read',
    description: '读取文本文件内容（支持按行分页，offset 为 1-based 起始行，limit ≤ 2000）或列出目录内容。路径为绝对路径或相对工作区路径。',
    permission: 'read',
    kind: 'shell',
    category: 'business',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件或目录路径（绝对或相对工作区）' },
        offset: { type: 'number', description: '起始行号（1-based，缺省 1）' },
        limit: { type: 'number', description: '最多读取的行数（缺省 2000）' },
      },
      required: ['path'],
    },
    execute: async (input) => {
      const { path, offset = 1, limit = MAX_READ_LINES } = input as { path: string; offset?: number; limit?: number }
      const target = resolvePath(root, path)
      const info = await inspect(target)
      if (!info) return { text: `无法访问 ${target}` }

      if (info.isDirectory) {
        const entries = await readdir(target, { withFileTypes: true })
        const start = Math.max(1, offset) - 1
        const slice = entries.slice(start, start + limit)
        const lines = slice.map((e) => `${start + 1 + slice.indexOf(e)}: ${e.name}${e.isDirectory() ? '/' : ''}`)
        const truncated = entries.length > start + limit
        return { text: `目录 ${target}:\n${lines.join('\n')}${truncated ? `\n…（共 ${entries.length} 项）` : ''}` }
      }

      const { readFile } = await import('node:fs/promises')
      const buffer = await readFile(target)
      if (isBinary(buffer)) return { text: `二进制文件，无法文本读取: ${target}` }
      const fullText = buffer.toString('utf8')
      // 超大文件截断到 MAX_READ_BYTES。
      const content = fullText.length > MAX_READ_BYTES ? fullText.slice(0, MAX_READ_BYTES) : fullText
      const lines = content.split('\n')
      const start = Math.max(1, offset) - 1
      const slice = lines.slice(start, start + limit)
      const numbered = slice.map((line, index) => `${start + index + 1}: ${line}`)
      const truncated = lines.length > start + limit || fullText.length > MAX_READ_BYTES
      return {
        text: `文件 ${target}:\n${numbered.join('\n')}${truncated ? `\n…（共 ${lines.length} 行）` : ''}`,
      }
    },
  }
}
