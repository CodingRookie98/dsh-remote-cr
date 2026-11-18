#!/usr/bin/env node
/**
 * 从 `src/client/locales.ts` 生成错误码索引，写进 `docs/troubleshooting.md`。
 *
 * 为什么生成而不是手写：我们有几十个错误码，手写表必然漂移——而「码表缺一条」的
 * 后果是用户拿着 `remote/port-in-use` 搜不到任何东西（参考实现同样栽过）。
 *
 * 用法：
 *   node scripts/gen-error-index.mjs           # 重写生成区
 *   node scripts/gen-error-index.mjs --check   # CI 用：与文件不一致则 exit 1
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const DOC = join(root, 'docs', 'troubleshooting.md')
const BEGIN = '<!-- BEGIN GENERATED: error-codes -->'
const END = '<!-- END GENERATED: error-codes -->'

// Windows 上动态 import 必须给 file:// URL，否则 Node 把 `D:` 当成协议名。
const { zh, en } = await import(pathToFileURL(join(root, 'src', 'client', 'locales.ts')).href)

/** 把 `{name}` 占位符换成 `…`，避免表格里出现未插值的花括号。 */
function plain(text) {
  return String(text).replace(/\{[a-z]+\}/gi, '…').replace(/\|/g, '\\|').trim()
}

const codes = Object.keys(zh)
  .filter((key) => key.startsWith('err.'))
  .sort()
const rows = codes.map((key) => {
  const code = key.slice('err.'.length)
  const nextKey = 'errNext.' + code
  const next = Object.keys(zh)
    .filter((candidate) => candidate === nextKey || candidate.startsWith(nextKey + '.'))
    .map((candidate) => plain(zh[candidate]))
    .filter((text) => text !== '')
  return `| \`${code}\` | ${plain(zh[key])} | ${plain(en[key] ?? '')} | ${next.length === 0 ? '—' : next.join(' ')} |`
})

const block = [
  BEGIN,
  `<!-- 由 scripts/gen-error-index.mjs 生成，共 ${rows.length} 条；不要手改。 -->`,
  '',
  '| 错误码 | 中文文案 | English | 下一步 |',
  '|---|---|---|---|',
  ...rows,
  END,
].join('\n')

const markdown = readFileSync(DOC, 'utf8')
const start = markdown.indexOf(BEGIN)
const end = markdown.indexOf(END)
if (start < 0 || end < 0) {
  console.error('docs/troubleshooting.md 缺少生成区标记：' + BEGIN + ' / ' + END)
  process.exit(2)
}
const nextDoc = markdown.slice(0, start) + block + markdown.slice(end + END.length)

if (process.argv.includes('--check')) {
  if (nextDoc !== markdown) {
    console.error('错误码索引已过期：跑 `node scripts/gen-error-index.mjs` 重新生成')
    process.exit(1)
  }
  console.log('error-index: OK（' + rows.length + ' 条与字典一致）')
} else {
  writeFileSync(DOC, nextDoc)
  console.log('error-index: 已写入 ' + rows.length + ' 条')
}
