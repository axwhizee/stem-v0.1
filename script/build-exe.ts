/**
 * 单文件构建试验：esbuild 打成 CJS → Node SEA 注入 node.exe 副本。
 * 用法: node --import tsx script/build-exe.ts
 * 产物: dist/stem-bundle.cjs, dist/stem.exe
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dist = join(root, 'dist')
mkdirSync(dist, { recursive: true })

const bundlePath = join(dist, 'stem-bundle.cjs')
const seaConfigPath = join(dist, 'sea-config.json')
const blobPath = join(dist, 'sea-prep.blob')
const exeOut = join(dist, process.platform === 'win32' ? 'stem.exe' : 'stem')

console.log('0) gen-static（嵌入 webui/dashboard 静态资源）…')
execFileSync(process.execPath, ['--import', 'tsx', join(root, 'script', 'gen-static.ts')], {
  stdio: 'inherit',
  cwd: root,
})

console.log('1) esbuild bundle (cjs, node platform)…')
await build({
  entryPoints: [join(root, 'bin/stem.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node23',
  outfile: bundlePath,
  minify: false,
  sourcemap: false,
  // 动态加载的用户工具/策略仍走磁盘；原生/实验模块保持 external
  external: ['node:sqlite', 'tsx'],
  // UMD 里 require('./impl/…') 会被 SEA embedderRequire 误判为 builtin → 必须走 ESM 入口
  mainFields: ['module', 'main'],
  conditions: ['import', 'node'],
  banner: {
    // ESM 互操作垫片（dynamic import of CJS/ESM）
    js: [
      "const __import_meta_url = require('url').pathToFileURL(__filename).href;",
      'const __dynamic_import = (s) => import(s);',
    ].join('\n'),
  },
  define: { 'import.meta.url': '__import_meta_url' },
  logLevel: 'info',
})

// esbuild 不会改写 dynamic import 的字符串字面量为 require——保留 import() 以便加载磁盘模块
console.log('2) sea-config…')
writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: true,
    },
    null,
    2,
  ),
)

console.log('3) node --experimental-sea-config…')
execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], {
  stdio: 'inherit',
  cwd: root,
})

console.log('4) copy node.exe + postject…')
const nodeExe = process.execPath
copyFileSync(nodeExe, exeOut)

// postject 注入（无则提示 npm i -D postject）
const postject = join(root, 'node_modules', 'postject', 'dist', 'cli.js')
if (!existsSync(postject)) {
  console.error('缺少 postject：npm i -D postject 后重跑')
  process.exit(1)
}
const seaBlob = readFileSync(blobPath)
execFileSync(
  process.execPath,
  [
    postject,
    exeOut,
    'NODE_SEA_BLOB',
    blobPath,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ],
  { stdio: 'inherit', cwd: root },
)

console.log(`OK → ${exeOut}`)
console.log('冒烟: dist/stem.exe version')
