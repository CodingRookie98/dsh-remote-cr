#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 抽出某个版本的正文，供 GitHub Release 使用。
 *
 * 为什么写脚本而不是手贴：Release 正文与 CHANGELOG 一旦各写一遍，必然只剩一份是新的。
 * 这里让 Release 直接取 CHANGELOG 的 `## [x.y.z]` 段，唯一真相源留在仓库里。
 *
 * 用法：
 *   node scripts/extract-release-notes.mjs 0.4.0            # 打到 stdout
 *   node scripts/extract-release-notes.mjs 0.4.0 --out FILE # 写到文件（CI 用）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const version = (process.argv[2] ?? '').replace(/^v/, '')
if (version === '') {
  console.error('用法：node scripts/extract-release-notes.mjs <version> [--out FILE]')
  process.exit(2)
}

const changelog = readFileSync(join(process.cwd(), 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n')
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const start = changelog.search(new RegExp('^## \\[' + escaped + '\\]', 'm'))
if (start < 0) {
  console.error('CHANGELOG.md 里没有版本 ' + version + ' 的段落')
  process.exit(1)
}
// 到下一个二级标题（或文件结尾）为止。
const rest = changelog.slice(start)
const nextHeading = rest.slice(1).search(/^## /m)
const section = (nextHeading < 0 ? rest : rest.slice(0, nextHeading + 1)).trimEnd()

const outAt = process.argv.indexOf('--out')
if (outAt >= 0) {
  const file = process.argv[outAt + 1]
  if (file === undefined) {
    console.error('--out 需要一个文件路径')
    process.exit(2)
  }
  writeFileSync(file, section + '\n')
  console.log('已写入 ' + file + '（' + section.split('\n').length + ' 行）')
} else {
  console.log(section)
}
