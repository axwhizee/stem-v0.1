// ============================================================
// extension/tools/webfetch/htmlExtract.ts —— 零依赖 HTML 抽取（纯函数，可测）
//
// 原型定位：够用即可的 text/markdown 转换（opencode 用 turndown，我们保持
// 零新增依赖；转换质量满足"给模型读正文"的用途）。
// ============================================================

/** 整体丢弃的噪声块（含内容）。 */
const NOISE = /<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>|<template[\s\S]*?<\/template>|<svg[\s\S]*?<\/svg>|<iframe[\s\S]*?<\/iframe>|<head[\s\S]*?<\/head>/gi

/** 常见实体 + 数字实体解码。 */
export function decodeEntities(s: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    mdash: '—', ndash: '–', hellip: '…', middot: '·', laquo: '«', raquo: '»',
    copy: '©', reg: '®', deg: '°', bull: '•', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  }
  return s
    .replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (all, code: string) => {
      if (code.startsWith('#x') || code.startsWith('#X')) {
        const cp = Number.parseInt(code.slice(2), 16)
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : all
      }
      if (code.startsWith('#')) {
        const cp = Number.parseInt(code.slice(1), 10)
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : all
      }
      return named[code.toLowerCase()] ?? all
    })
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '')
}

/** 块级收尾 → 换行；行内噪声空白收敛。 */
function collapse(s: string): string {
  return s
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** HTML → 纯文本。 */
export function htmlToText(html: string): string {
  let s = html.replace(NOISE, ' ')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|li|ul|ol|tr|table|h[1-6]|blockquote|pre|section|article|aside|header|footer|nav|main|figure|figcaption|dl|dt|dd|details|summary|form|fieldset)>/gi, '\n')
  s = stripTags(s)
  return collapse(decodeEntities(s))
}

/** HTML → markdown 近似（标题/链接/列表/强调/代码/图片/引用线）。 */
export function htmlToMarkdown(html: string): string {
  let s = html.replace(NOISE, ' ')
  // 图片 → ![alt](src)
  s = s.replace(/<img\b[^>]*?>/gi, (tag) => {
    const alt = /alt="([^"]*)"/i.exec(tag)?.[1] ?? ''
    const src = /src="([^"]*)"/i.exec(tag)?.[1] ?? ''
    return src ? `![${alt}](${src})` : ' '
  })
  // 链接 → 文本 (url)（仅 http(s)，锚点/伪协议丢弃）
  s = s.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_all, href: string, inner: string) => {
    const text = collapse(decodeEntities(stripTags(inner)))
    if (/^https?:\/\//i.test(href) && text !== '') return `${text} (${href})`
    return text
  })
  // 标题 → #…
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_all, level: string, inner: string) => {
    const text = collapse(decodeEntities(stripTags(inner)))
    return text === '' ? ' ' : `\n${'#'.repeat(Number(level))} ${text}\n`
  })
  // 列表项 / 引用 / 分隔线 / 代码
  s = s.replace(/<li\b[^>]*>/gi, '\n- ')
  s = s.replace(/<blockquote\b[^>]*>/gi, '\n> ')
  s = s.replace(/<hr\b[^>]*?>/gi, '\n---\n')
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_all, inner: string) => `\n\`\`\`\n${decodeEntities(stripTags(inner)).trim()}\n\`\`\`\n`)
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_all, inner: string) => `\`${decodeEntities(stripTags(inner)).trim()}\``)
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
  // 其余块级收尾换行 + 剥净残余标签
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|ul|ol|table|tr|section|article|aside|header|footer|nav|main|figure|figcaption|dl|dt|dd|details|summary|form|fieldset|h[1-6]|blockquote|pre|li)>/gi, '\n')
  s = stripTags(s)
  return collapse(decodeEntities(s))
}
