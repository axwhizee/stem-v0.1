// ============================================================
// extension/tools/fs-util.ts —— host 文件工具共享辅助（node fs）
//
// 内置宿主工具（kind=extension）操作真实文件系统；core 零平台
// 依赖，因此实现放在 core 之外（shell 宿主层）。
// ============================================================

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, isAbsolute, normalize, resolve } from 'node:path'

/** 解析输入路径：绝对路径直接用；相对路径基于 workspace 根。 */
export function resolvePath(root: string, input: string): string {
  const path = isAbsolute(input) ? input : join(root, input)
  return normalize(path)
}

/** 二进制检测：含 NUL 字节即视为二进制。 */
export function isBinary(buffer: Buffer): boolean {
  // 检查前 8KB 是否含 NUL（文本文件通常无 NUL）。
  const sample = buffer.subarray(0, 8192)
  return sample.includes(0)
}

/** 读文本（若不存在或二进制返回 undefined）。 */
export async function readText(target: string): Promise<string | undefined> {
  try {
    const buffer = await readFile(target)
    if (isBinary(buffer)) return undefined
    return buffer.toString('utf8')
  } catch {
    return undefined
  }
}

export interface FileStat {
  readonly path: string
  readonly isDirectory: boolean
}

/** 目标是否可访问 + 类型（不存在返回 undefined）。 */
export async function inspect(target: string): Promise<FileStat | undefined> {
  try {
    const s = await stat(target)
    return { path: target, isDirectory: s.isDirectory() }
  } catch {
    return undefined
  }
}

/** 递归遍历目录下的文本文件（排除 .git / node_modules）。 */
export async function walkTextFiles(root: string): Promise<string[]> {
  const results: string[] = []
  const excluded = new Set(['.git', 'node_modules'])
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (excluded.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else {
        results.push(full)
      }
    }
  }
  await walk(root)
  return results
}

/** glob 模式转正则（支持 **、*、?、{a,b}）。 */
export function globToRegExp(glob: string): RegExp {
  let pattern = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] as string
    if (char === '*') {
      if (glob[i + 1] === '*') {
        // **：跨路径任意（含斜杠）
        pattern += '.*'
        i++
      } else {
        // *：单段内任意（不含斜杠）
        pattern += '[^/]*'
      }
    } else if (char === '?') {
      pattern += '[^/]'
    } else if (char === '{') {
      const close = glob.indexOf('}', i)
      if (close > i) {
        const choices = glob
          .slice(i + 1, close)
          .split(',')
          .map((c) => c.replace(/[.+^$()\[\]|\\]/g, '\\$&'))
        pattern += `(?:${choices.join('|')})`
        i = close
      } else {
        pattern += '\\{'
      }
    } else {
      pattern += /[.+^$()\[\]|\\]/.test(char) ? `\\${char}` : char
    }
  }
  return new RegExp(`^${pattern}$`)
}

export { resolve }
