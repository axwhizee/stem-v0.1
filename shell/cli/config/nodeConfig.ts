// ============================================================
// shell/config/nodeConfig.ts —— node fs 版配置存储（宿主实现）
//
// core 零平台依赖：ConfigStore / InitFs 接口由宿主注入。
// 本文件实现：
//   - ConfigStore：读/写 `<projectRoot>/.stem/stem.json(c)`；
//   - InitFs：列出 tool/agent 目录、读文本；
//   - loadUserTool：动态 import 用户工具模块。
// ============================================================

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ConfigLoadResult, ConfigPaths, ConfigStore, StemConfig } from '../../../src/core/config'
import { parseConfigText } from '../../../src/core/config'
import type { ClassFs, InitFs, InitToolLoader } from '../../../src/core/main'

/** 解析 `.stem/` 目录结构（先看 stem.jsonc，再看 stem.json）。 */
export function resolveConfigPaths(projectRoot: string): ConfigPaths {
  const root = resolve(projectRoot)
  const configDir = join(root, '.stem')
  return {
    projectRoot: root,
    configDir,
    configFile: join(configDir, 'stem.jsonc'),
    toolDir: join(configDir, 'tools'),
    agentDir: join(configDir, 'agent'),
    strategyDir: join(configDir, 'context'),
  }
}

/** node fs 版配置存储。 */
export function createNodeConfigStore(paths: ConfigPaths): ConfigStore {
  return {
    file: paths.configFile,
    async load(): Promise<ConfigLoadResult> {
      // 优先 stem.jsonc，其次 stem.json。
      const candidates = [join(paths.configDir, 'stem.jsonc'), join(paths.configDir, 'stem.json')]
      for (const file of candidates) {
        try {
          const text = await readFile(file, 'utf8')
          return { exists: true, config: parseConfigText(text, file), raw: text }
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue
          // 解析错误（非 ENOENT）直接抛出，让 init 暴露。
          throw cause
        }
      }
      return { exists: false, config: {} }
    },
    async save(text: string): Promise<void> {
      await mkdir(paths.configDir, { recursive: true })
      await writeFile(paths.configFile, text, 'utf8')
    },
  }
}

/** node fs 版目录扫描/读取。 */
export function createNodeInitFs(): InitFs {
  return {
    async listFiles(dir: string): Promise<readonly string[]> {
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        return entries
          .filter((e) => e.isFile() && !e.name.startsWith('.'))
          .map((e) => join(dir, e.name))
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw cause
      }
    },
    async listDirs(dir: string): Promise<readonly string[]> {
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        return entries
          .filter((e) => e.isDirectory())
          .map((e) => join(dir, e.name))
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw cause
      }
    },
    async readText(file: string): Promise<string> {
      return readFile(file, 'utf8')
    },
  }
}

/**
 * node fs 版类回写端口（S5.2 进化书写面）：`.stem/agent/` 目录确保 + 写文件。
 * 序列化在 core（agentSerialize），这里只提供 IO 原语。
 */
export function createNodeClassFs(): ClassFs {
  return {
    async ensureDir(dir: string): Promise<void> {
      await mkdir(dir, { recursive: true })
    },
    async writeText(file: string, content: string): Promise<void> {
      await writeFile(file, content, 'utf8')
    },
  }
}

/** node 动态 import 用户工具（tsx 环境下可加载 .ts）。 */
export const nodeToolLoader: InitToolLoader = {
  async loadTool(file: string): Promise<{ readonly default?: unknown }> {
    const url = pathToFileURL(isAbsolute(file) ? file : resolve(file)).href
    const mod = (await import(url)) as { readonly default?: unknown }
    return mod
  },
}

/** 便捷：一键构造 node 环境的 init 依赖所需 fs/store/loader。 */
export function createNodeConfigBundle(projectRoot: string): {
  readonly paths: ConfigPaths
  readonly store: ConfigStore
  readonly fs: InitFs
  readonly classFs: ClassFs
  readonly loadTool: (file: string) => Promise<{ readonly default?: unknown }>
} {
  const paths = resolveConfigPaths(projectRoot)
  return {
    paths,
    store: createNodeConfigStore(paths),
    fs: createNodeInitFs(),
    classFs: createNodeClassFs(),
    loadTool: nodeToolLoader.loadTool.bind(nodeToolLoader),
  }
}

export type { StemConfig }
