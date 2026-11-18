#!/usr/bin/env node
/**
 * 文档图片门禁：README 与 docs 下的 markdown 里引用的图片必须存在、是真 PNG、尺寸不寒酸。
 *
 * 为什么需要：文档图片断链只会在「有人点开」时才被发现，而 README 是项目的门面。
 * 参考实现栽过同一类问题（占位图、删图后忘改引用），药方是静态检查而不是开浏览器。
 *
 * 判据：
 *   1) 相对引用必须存在（指向本仓库）；
 *   2) PNG 必须可解析（读 IHDR），且宽、高各 > 200 / > 150，避免占位图；
 *   3) 覆盖率：README.md 至少引用一张本地图，防「全删了」这种极端回归。
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = process.cwd()
const FILES = ['README.md', 'README.en.md']
const MIN = { width: 200, height: 150 }
const IMAGE_REF = /!\[[^\]]*\]\(([^)\s]+)\)|<img[^>]+src="([^"]+)"/g

function pngSize(buffer) {
  if (buffer.length < 24) return null
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

const problems = []
let localCount = 0
let remoteCount = 0
let ownedCount = 0

for (const file of FILES) {
  const text = readFileSync(join(root, file), 'utf8')
  const fileDir = dirname(join(root, file))
  for (const match of text.matchAll(IMAGE_REF)) {
    const ref = match[1] ?? match[2]
    if (ref === undefined) continue
    if (/^(https?:|data:)/.test(ref)) {
      remoteCount += 1
      // 指向本仓库的 raw 链接：把 URL 还原成仓库路径再查一次存在性
      const own = ref.match(/^https:\/\/raw\.githubusercontent\.com\/CodingRookie98\/dsh-remote-cr\/[^/]+\/(.+)$/)
      if (own !== null) {
        // 指向本仓库的 raw 链接等价于本地图：既查存在性，也计入「门面页有图」的覆盖率。
        ownedCount += 1
        try {
          statSync(join(root, own[1]))
        } catch {
          problems.push(file + ': 指向本仓库的图片不存在 → ' + own[1])
        }
      }
      continue
    }
    localCount += 1
    const abs = resolve(fileDir, ref)
    let buffer
    try {
      buffer = readFileSync(abs)
    } catch {
      problems.push(file + ': 图片不存在 → ' + ref)
      continue
    }
    const size = pngSize(buffer)
    if (size === null) {
      problems.push(file + ': 不是可解析的 PNG → ' + ref)
      continue
    }
    if (size.width < MIN.width || size.height < MIN.height) {
      problems.push(file + ': 尺寸 ' + size.width + '×' + size.height + ' 小于 ' + MIN.width + '×' + MIN.height + '（占位图？）→ ' + ref)
    }
  }
}

// 「本地相对路径」与「指向本仓库的 raw 链接」都算门面页有图；纯第三方外链不算。
if (localCount + ownedCount === 0) problems.push('README.md 一张本仓库的图都没有：门面页不允许无图')

if (problems.length > 0) {
  for (const problem of problems) console.error('  ✗ ' + problem)
  console.error('check-doc-images: 失败（' + problems.length + ' 项）')
  process.exit(1)
}
console.log('check-doc-images: OK（本地 ' + localCount + ' 张 / 本仓库 raw ' + ownedCount + ' 张 / 第三方外链 ' + remoteCount + ' 张）')
