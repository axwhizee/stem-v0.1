// ============================================================
// core/tools/skill.test.ts —— skill 注册表 + skill 工具 + init 生命周期单测
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DefaultSkillRegistry } from './SkillRegistry'
import { createSkillTool, parseSkillFile } from './skill'
import { DefaultToolCapabilityRegistry } from './ToolCapabilityRegistry'
import type { ToolInitContext } from './types'

const SKILL_MD = `---
name: web-search
description: 相似搜索工具的渐进披露载体（schema + 用法）。
---
# Web Search

## schema
{ "name": "web_search", "parameters": { "q": "string" } }

## 用法
搜索前先确认意图…
`

describe('SkillRegistry', () => {
  test('register/get/list/manifest', () => {
    const registry = new DefaultSkillRegistry()
    registry.register({ name: 'a', description: 'desc-a', body: 'body-a' })
    registry.register({ name: 'b', description: 'desc-b', body: 'body-b' })

    assert.equal(registry.get('a')?.body, 'body-a')
    assert.equal(registry.get('missing'), undefined)
    assert.equal(registry.list().length, 2)
    const manifest = registry.manifest()
    assert.ok(manifest.includes('<available_skills>'))
    assert.ok(manifest.includes('<name>a</name>'))
    assert.ok(manifest.includes('<description>desc-b</description>'))
  })

  test('重复注册 → skill_conflict', () => {
    const registry = new DefaultSkillRegistry()
    registry.register({ name: 'a', description: '', body: 'b' })
    assert.throws(
      () => registry.register({ name: 'a', description: '', body: 'c' }),
      (e: unknown) => (e as { kind: string }).kind === 'skill_conflict',
    )
  })

  test('空注册表 manifest 为空串', () => {
    assert.equal(new DefaultSkillRegistry().manifest(), '')
  })
})

describe('parseSkillFile', () => {
  test('解析 YAML 头 + 正文', () => {
    const info = parseSkillFile(SKILL_MD, 'web-search.md')
    assert.equal(info.name, 'web-search')
    assert.equal(info.description, '相似搜索工具的渐进披露载体（schema + 用法）。')
    assert.ok(info.body.includes('## 用法'))
    assert.equal(info.file, 'web-search.md')
  })

  test('缺 name → 文件名兜底；缺 description → 空串', () => {
    const info = parseSkillFile(`---\n---\n正文内容`, 'foo.md')
    assert.equal(info.name, 'foo')
    assert.equal(info.description, '')
  })

  test('正文为空 → 抛错', () => {
    assert.throws(() => parseSkillFile('---\nname: x\n---', 'x.md'), /正文为空/)
  })
})

describe('skill 工具（init 生命周期 + 懒加载）', () => {
  test('init 扫描 skill 目录并注册；execute 懒加载正文', async () => {
    const skills = new DefaultSkillRegistry()
    const tool = createSkillTool({ skills })
    const registry = new DefaultToolCapabilityRegistry()
    await registry.register(tool)

    const ctx: ToolInitContext = {
      skills,
      skillDir: '/skills',
      fs: {
        listFiles: async () => ['web-search.md', 'note.txt'],
        readText: async (file) => {
          assert.ok(file.endsWith('/web-search.md'))
          return SKILL_MD
        },
      },
    }
    await registry.initAll(ctx)

    assert.equal(skills.list().length, 1)
    assert.equal(skills.get('web-search')?.name, 'web-search')

    const result = await registry.execute({ id: 'c1', name: 'skill', input: { name: 'web-search' } }, { agentId: 'a', spaceId: 's' })
    assert.ok(result.text.includes('# Skill: web-search'))
    assert.ok(result.text.includes('## 用法'))
  })

  test('无 fs/skillDir 时 init 为 no-op（不注册）', async () => {
    const skills = new DefaultSkillRegistry()
    const tool = createSkillTool({ skills })
    const registry = new DefaultToolCapabilityRegistry()
    await registry.register(tool)
    await registry.initAll({ skills })
    assert.equal(skills.list().length, 0)
  })

  test('execute 加载不存在的 skill → 抛错', async () => {
    const skills = new DefaultSkillRegistry()
    const tool = createSkillTool({ skills })
    const registry = new DefaultToolCapabilityRegistry()
    await registry.register(tool)
    await assert.rejects(
      () => registry.execute({ id: 'c1', name: 'skill', input: { name: 'missing' } }, { agentId: 'a', spaceId: 's' }),
      (e: unknown) => (e as { kind: string }).kind === 'execution_failed',
    )
  })
})

describe('工具 init 生命周期', () => {
  test('registry.initAll 按注册顺序调用每个工具的 init（幂等由工具保证）', async () => {
    const order: string[] = []
    const registry = new DefaultToolCapabilityRegistry()
    await registry.register({
      id: 't1',
      description: 'd',
      parameters: { type: 'object', properties: {} },
      init: () => void order.push('t1'),
      execute: () => ({ text: 'ok' }),
    })
    await registry.register({
      id: 't2',
      description: 'd',
      parameters: { type: 'object', properties: {} },
      init: async () => {
        order.push('t2')
      },
      execute: () => ({ text: 'ok' }),
    })
    await registry.initAll({})
    assert.deepEqual(order, ['t1', 't2'])
  })
})