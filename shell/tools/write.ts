// ============================================================
// shell/tools/write.ts —— write 工具（kind=shell，权限 edit）
//
// 参考 opencode write：全量写入文本文件，父目录自动创建，
// 不支持 append；权限名与 edit 共享 'edit'。
// ============================================================

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ToolCapability } from '../../src/core/tools'
import { resolvePath } from './fs-util'

export function createWriteTool(root: string): ToolCapability {
  return {
    id: 'write',
    description: '写入文本内容到文件（全量覆盖，父目录自动创建）。路径为绝对路径或相对工作区路径。',
    accessKey: 'edit',
    kind: 'shell',
    category: 'business',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标文件路径（绝对或相对工作区）' },
        content: { type: 'string', description: '要写入的完整文本内容' },
      },
      required: ['path', 'content'],
    },
    execute: async (input) => {
      const { path, content } = input as { path: string; content: string }
      const target = resolvePath(root, path)
      try {
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, content, 'utf8')
        return { text: `已写入 ${target}` }
      } catch (error) {
        return { text: `写入失败: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }
}
