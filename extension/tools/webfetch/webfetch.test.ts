// ============================================================
// extension/tools/webfetch/webfetch.test.ts —— 抽取纯函数 + 工具行为（假 fetch 注入）
// ============================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeEntities, htmlToMarkdown, htmlToText } from './htmlExtract'
import { createWebFetchTool, type WebFetchLike, type WebFetchResponse } from './webfetch'
import type { ToolContext } from '../../../src/core/tools'

const CTX = { agentId: 'a1', spaceId: 's1' } as ToolContext

function fakeFetch(
  response: Partial<WebFetchResponse> & { body: string },
): { fetch: WebFetchLike; urls: string[] } {
  const urls: string[] = []
  const fetch: WebFetchLike = async (url) => {
    urls.push(url)
    return {
      status: response.status ?? 200,
      url: response.url ?? url,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? response.headers?.get?.(name) ?? 'text/html; charset=utf-8' : null) },
      text: async () => response.body,
    }
  }
  return { fetch, urls }
}

test('decodeEntities：命名/数字/十六进制实体', () => {
  assert.equal(decodeEntities('a &amp; b &#65; &#x42; &nbsp;&hellip;'), 'a & b A B  …')
})

test('htmlToText：剥噪声块与标签、块级换行、空白收敛', () => {
  const html = `<html><head><title>t</title><style>p{color:red}</style></head><body>
    <script>var x = "<div>fake</div>";</script>
    <h1>标题</h1><p>第一段<br>换行</p><div>第二块</div></body></html>`
  assert.equal(htmlToText(html), '标题\n第一段\n换行\n第二块')
})

test('htmlToMarkdown：标题/链接/列表/强调/代码/图片', () => {
  const html =
    '<h2>安装</h2><ul><li>运行 <code>npm i</code></li><li><strong>重要</strong>步骤</li></ul>' +
    '<p>详见 <a href="https://doc.dev/x">文档</a> 与 <a href="#anchor">锚点</a></p>' +
    '<img alt="图" src="i.png"/><blockquote>引用</blockquote><hr/>'
  const md = htmlToMarkdown(html)
  assert.match(md, /^## 安装/m)
  assert.match(md, /- 运行 `npm i`/)
  assert.match(md, /\*\*重要\*\*/)
  assert.match(md, /文档 \(https:\/\/doc\.dev\/x\)/)
  assert.doesNotMatch(md, /#anchor/) // 锚点链接只留文本
  assert.match(md, /!\[图\]\(i\.png\)/)
  assert.match(md, /> 引用/)
  assert.match(md, /^---$/m)
})

test('webfetch：markdown 转换 + 尾注来源 URL', async () => {
  const page = fakeFetch({ body: '<h1>Hi</h1><p>正文</p>', url: 'https://site.dev/page' })
  const tool = createWebFetchTool({ fetch: page.fetch })
  const r = await tool.execute({ url: 'https://site.dev/page' }, CTX)
  assert.match(r.text, /^# Hi/m)
  assert.match(r.text, /正文/)
  assert.match(r.text, /—— 抓取于 https:\/\/site\.dev\/page/)
})

test('webfetch：format=text 退化纯文本；format=html 原样', async () => {
  const page = fakeFetch({ body: '<h1>Hi</h1><p>正文 &amp; 更多</p>' })
  const tool = createWebFetchTool({ fetch: page.fetch })
  assert.match((await tool.execute({ url: 'https://a.dev', format: 'text' }, CTX)).text, /Hi\n正文 & 更多/)
  assert.match((await tool.execute({ url: 'https://a.dev', format: 'html' }, CTX)).text, /<h1>Hi<\/h1>/)
})

test('webfetch：原生 markdown 直出（content-type=text/markdown 不转换）', async () => {
  const fetch: WebFetchLike = async (url) => ({
    status: 200,
    url,
    headers: { get: () => 'text/markdown' },
    text: async () => '# 原生\n- md',
  })
  const tool = createWebFetchTool({ fetch })
  const r = await tool.execute({ url: 'https://raw.dev/x.md' }, CTX)
  assert.match(r.text, /^# 原生\n- md/)
})

test('webfetch：非文本类型拒回内容；HTTP 4xx/5xx 可行动失败文本', async () => {
  const bin = createWebFetchTool({
    fetch: async (url) => ({ status: 200, url, headers: { get: () => 'image/png' }, text: async () => 'PNG…' }),
  })
  assert.match((await bin.execute({ url: 'https://a.dev/x.png' }, CTX)).text, /不支持的响应类型/)
  const err = createWebFetchTool({
    fetch: async (url) => ({ status: 404, url, headers: { get: () => 'text/html' }, text: async () => 'nope' }),
  })
  assert.match((await err.execute({ url: 'https://a.dev/gone' }, CTX)).text, /HTTP 404/)
})

test('webfetch：重定向跟随（≤5 跳）与超限止损', async () => {
  let hops = 0
  const looping = createWebFetchTool({
    fetch: async (url) => {
      hops++
      return { status: 302, url, headers: { get: (n) => (n.toLowerCase() === 'location' ? url : null) }, text: async () => '' }
    },
  })
  const r = await looping.execute({ url: 'https://loop.dev/a' }, CTX)
  assert.equal(hops, 6) // 初始 + 5 跳后放弃
  assert.match(r.text, /HTTP 302|无可见文本/)
})

test('webfetch：输出截断带原长提示', async () => {
  const big = fakeFetch({ body: `<p>${'字'.repeat(1200)}</p>` })
  const tool = createWebFetchTool({ fetch: big.fetch })
  const r = await tool.execute({ url: 'https://long.dev', maxChars: 500 }, CTX)
  assert.match(r.text, /截断：原长 \d+ 字符/)
})

test('webfetch：url 校验（非 http/https 拒绝）', async () => {
  const tool = createWebFetchTool({ fetch: async () => { throw new Error('不该到达 fetch') } })
  assert.match((await tool.execute({ url: 'file:///etc/passwd' }, CTX)).text, /必须是 http\(s\)/)
  assert.match((await tool.execute({ url: '' }, CTX)).text, /必须是 http\(s\)/)
})
