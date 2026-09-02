// ============================================================
// extension/tools/_lib/tools.test.ts —— extension 工具五件套集成测试
// （read/write/edit/grep/glob，真实 fs + mkdtemp 临时空间）
// ============================================================

import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ToolContext } from '../../../src/core/tools'
import { createReadTool } from '../read/read'
import { createWriteTool } from '../write/write'
import { createEditTool } from '../edit/edit'
import { createGrepTool } from '../grep/grep'
import { createGlobTool } from '../glob/glob'

let root: string
const ctx: ToolContext = { agentId: 'a1', spaceId: 's1' }

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'stem-tools-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'a.ts'), 'const x = 1\nconst hello = 2\n', 'utf8')
  await writeFile(join(root, 'README.md'), '# Title\n\nhello world\n', 'utf8')
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('host 文件工具', () => {
  test('read：读取文本文件（带行号）', async () => {
    const tool = createReadTool(root)
    const result = await tool.execute({ path: 'src/a.ts' }, ctx)
    assert.match(result.text, /src\/a\.ts/)
    assert.match(result.text, /1: const x = 1/)
    assert.match(result.text, /2: const hello = 2/)
  })

  test('read：offset/limit 分页', async () => {
    const tool = createReadTool(root)
    const result = await tool.execute({ path: 'src/a.ts', offset: 2, limit: 1 }, ctx)
    assert.match(result.text, /2: const hello = 2/)
    assert.doesNotMatch(result.text, /1: const x = 1/)
  })

  test('read：列出目录', async () => {
    const tool = createReadTool(root)
    const result = await tool.execute({ path: 'src' }, ctx)
    assert.match(result.text, /a\.ts/)
  })

  test('write：创建文件（自动建父目录）', async () => {
    const tool = createWriteTool(root)
    const result = await tool.execute({ path: 'nested/new.txt', content: 'line1' }, ctx)
    assert.match(result.text, /已写入/)
    assert.equal(await readFile(join(root, 'nested', 'new.txt'), 'utf8'), 'line1')
  })

  test('edit：精确替换 + 多次匹配需 replaceAll', async () => {
    const tool = createEditTool(root)
    // 0 次匹配
    const miss = await tool.execute({ path: 'src/a.ts', oldString: 'not-exist', newString: 'x' }, ctx)
    assert.match(miss.text, /未在文件中找到/)
    // 单次替换
    const ok = await tool.execute({ path: 'src/a.ts', oldString: 'const x', newString: 'const y' }, ctx)
    assert.match(ok.text, /已编辑/)
    assert.equal(await readFile(join(root, 'src', 'a.ts'), 'utf8'), 'const y = 1\nconst hello = 2\n')
    // 改回，避免影响后续
    await writeFile(join(root, 'src', 'a.ts'), 'const x = 1\nconst hello = 2\n', 'utf8')
  })

  test('grep：正则递归搜索', async () => {
    const tool = createGrepTool(root)
    const result = await tool.execute({ pattern: 'hello' }, ctx)
    assert.match(result.text, /找到/)
    assert.match(result.text, /hello world/)
    assert.match(result.text, /const hello = 2/)
  })

  test('grep include：纯文件名/相对路径均命中（匹配基准 = 相对搜索根，验收 P5 回归）', async () => {
    const tool = createGrepTool(root)
    const byName = await tool.execute({ pattern: 'hello', include: 'a.ts' }, ctx)
    assert.match(byName.text, /src/, 'basename 兜底应命中 src/a.ts')
    const byRel = await tool.execute({ pattern: 'hello', include: 'src/*.ts' }, ctx)
    assert.match(byRel.text, /a\.ts/)
    const miss = await tool.execute({ pattern: 'hello', include: 'zzz/*.ts' }, ctx)
    assert.match(miss.text, /未找到/)
  })

  test('glob：模式匹配文件', async () => {
    const tool = createGlobTool(root)
    const result = await tool.execute({ pattern: '**/*.ts' }, ctx)
    assert.match(result.text, /src\/a\.ts/)
    assert.doesNotMatch(result.text, /README/)
  })
})
