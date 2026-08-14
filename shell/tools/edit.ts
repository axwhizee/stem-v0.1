// ============================================================
// shell/tools/edit.ts —— edit 工具（kind=shell，权限 edit）
//
// 参考 opencode edit：oldString/newString 精确替换（非 diff）。
// - oldString 必须精确匹配（含空白/缩进）；
// - 0 次匹配 → 报错；多次匹配且未设 replaceAll → 报错；
// - 替换后写回原文件。
// ============================================================

import { writeFile } from 'node:fs/promises'
import type { ToolCapability } from '../../src/core/tools'
import { inspect, readText, resolvePath } from './fs-util'

export function createEditTool(root: string): ToolCapability {
  return {
    id: 'edit',
    description:
      '编辑文件：用 newString 精确替换 oldString（必须完全匹配，含空白与缩进）。oldString 不能为空；若匹配多处需设 replaceAll=true。',
    accessKey: 'edit',
    kind: 'shell',
    category: 'business',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标文件路径（绝对或相对工作区）' },
        oldString: { type: 'string', description: '要替换的精确文本（不能为空）' },
        newString: { type: 'string', description: '替换后的文本' },
        replaceAll: { type: 'boolean', description: '替换全部精确匹配（缺省 false）' },
      },
      required: ['path', 'oldString', 'newString'],
    },
    execute: async (input) => {
      const { path, oldString, newString, replaceAll } = input as {
        path: string
        oldString: string
        newString: string
        replaceAll?: boolean
      }
      if (oldString === '') return { text: '错误：oldString 不能为空（新建文件请用 write）' }
      if (oldString === newString) return { text: '错误：oldString 与 newString 相同' }

      const target = resolvePath(root, path)
      const info = await inspect(target)
      if (!info || info.isDirectory) return { text: `无法编辑 ${target}（不存在或为目录）` }

      const content = await readText(target)
      if (content === undefined) return { text: `无法读取 ${target}（二进制或不存在）` }

      const occurrences = countOccurrences(content, oldString)
      if (occurrences === 0) {
        return { text: '错误：未在文件中找到 oldString（必须精确匹配，包括空白和缩进）' }
      }
      if (occurrences > 1 && !replaceAll) {
        return { text: `错误：oldString 在文件中出现 ${occurrences} 次，请提供更多上下文或设置 replaceAll=true` }
      }

      const updated = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString)
      await writeFile(target, updated, 'utf8')
      return { text: `已编辑 ${target}（替换 ${replaceAll ? occurrences : 1} 处）` }
    },
  }
}

function countOccurrences(text: string, needle: string): number {
  let count = 0
  let index = 0
  for (;;) {
    index = text.indexOf(needle, index)
    if (index === -1) break
    count++
    index += needle.length
  }
  return count
}
