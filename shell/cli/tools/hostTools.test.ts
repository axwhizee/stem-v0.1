// ============================================================
// shell/tools/hostTools.test.ts —— host 外部工具（read/write/edit/grep/glob）
// ============================================================

import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ToolContext } from '../../../src/core/tools'
import { createReadTool } from './read'
import { createWriteTool } from './write'
import { createEditTool } from './edit'
import { createGrepTool } from './grep'
import { createGlobTool } from './glob'

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

  test('glob：模式匹配文件', async () => {
    const tool = createGlobTool(root)
    const result = await tool.execute({ pattern: '**/*.ts' }, ctx)
    assert.match(result.text, /src\/a\.ts/)
    assert.doesNotMatch(result.text, /README/)
  })
})
