/**
 * 生成 shell/cli/static.gen.ts：把 webui / dashboard 静态文件嵌进 bundle（SEA 友好）。
 * 用法: node --import tsx script/gen-static.ts
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function collect(dir: string, exts: Set<string>): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (exts.has(name.split('.').pop() ?? '')) out.push(p)
    }
  }
  walk(dir)
  return out
}

function pack(dir: string, files: string[], rootDir: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const f of files) {
    const key = relative(rootDir, f).split(sep).join('/')
    map[key] = readFileSync(f, 'utf8')
  }
  return map
}

const webDir = join(root, 'shell', 'webui')
const dashDir = join(root, 'shell', 'dashboard', 'public')
const webFiles = collect(webDir, new Set(['html', 'css', 'js'])).filter((f) => !f.endsWith('.test.js'))
const dashFiles = collect(dashDir, new Set(['html', 'css', 'js']))

const webMap = pack(webDir, webFiles, webDir)
const dashMap = pack(dashDir, dashFiles, dashDir)

// dashboard 还可能引用 webui/view.js（README：复用纯函数核心）——按路径一并带上
try {
  webMap['view.js'] = readFileSync(join(webDir, 'view.js'), 'utf8')
} catch {
  /* optional */
}

const code = `// 由 script/gen-static.ts 生成，勿手改。
export const WEB_STATIC: Readonly<Record<string, string>> = ${JSON.stringify(webMap, null, 2)}
export const DASH_STATIC: Readonly<Record<string, string>> = ${JSON.stringify(dashMap, null, 2)}
`

const outFile = join(root, 'shell', 'cli', 'static.gen.ts')
writeFileSync(outFile, code, 'utf8')
console.log(`wrote ${outFile} (web=${Object.keys(webMap).length} dash=${Object.keys(dashMap).length})`)
