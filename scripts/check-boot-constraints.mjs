#!/usr/bin/env node
/**
 * 启动脆弱性静态闸门（Boot-fragility gate）。
 *
 * 由来：参考实现曾在补丁里写了一个框架不接受的 id，结果**整个 DSH Desktop 起不来**，
 * 只能手工修。这类问题不是逻辑错误，语法与单测都发现不了，只有宿主加载插件的那一刻才炸。
 * 本脚本只做静态事实检查，不 import 库代码，CI 里几毫秒跑完。
 *
 * 判据：
 *   1) cordis.patch.yml 的每个 insert 行：id 合法、唯一、与 ADR-0006 规定一致；
 *   2) package.json#dsh：bundle.patch 文件存在、client.platform 有值、engines.dsh 非空；
 *   3) 命名铁律：teleport 只允许出现在 src/local/migration/ 与白名单文档里。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const problems = []
const notes = []

// ── 1) cordis.patch.yml ────────────────────────────────────────────────────
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8').replace(/\r\n/g, '\n')
const ids = [...patch.matchAll(/^\s*-\s*id:\s*([^\s#]+)\s*$/gm)].map((match) => match[1])
const names = [...patch.matchAll(/^\s*name:\s*['"]?([^'"\s#]+)['"]?\s*$/gm)].map((match) => match[1])

if (ids.length === 0) problems.push('cordis.patch.yml 没有任何 insert 行 id：插件不会被加载')
const seen = new Set()
for (const id of ids) {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) problems.push('行 id 不合法（需匹配 ^[a-z][a-z0-9-]*$）：' + id)
  if (seen.has(id)) problems.push('行 id 重复：' + id)
  seen.add(id)
}
if (!ids.includes('remote-cr')) problems.push('缺少 ADR-0006 规定的行 id：remote-cr（当前：' + ids.join(', ') + '）')
for (const name of names) {
  if (name !== 'dsh-remote-cr') problems.push('补丁里的包名应为 dsh-remote-cr（包名解析，不是相对路径）：' + name)
}

// ── 2) package.json#dsh ────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const dsh = pkg.dsh ?? {}
const bundlePatch = dsh.bundle?.patch
if (typeof bundlePatch !== 'string' || bundlePatch === '') {
  problems.push('package.json#dsh.bundle.patch 缺失：只声明 dsh.client 无法安装')
} else if (!existsSync(join(root, bundlePatch))) {
  problems.push('dsh.bundle.patch 指向的文件不存在：' + bundlePatch)
}
if (typeof dsh.client?.platform !== 'string' || dsh.client.platform === '') {
  problems.push('package.json#dsh.client.platform 缺失：浏览器半不会被加载')
}
if (typeof dsh.engines?.dsh !== 'string' || dsh.engines.dsh.trim() === '') {
  problems.push('package.json#dsh.engines.dsh 缺失：宿主版本范围必须显式声明')
} else {
  notes.push('engines.dsh = ' + dsh.engines.dsh)
}

// ── 3) 命名铁律（ADR-0006）─────────────────────────────────────────────────
// 扫描范围 = 代码 + **现行文档**。历史快照按政策保留旧名（见 docs/README.md「命名沿革」），
// 所以 docs/project/**（plans/reviews）、docs/research/**、docs/release/** 整体豁免。
const SCAN_ROOTS = ['src', 'scripts', 'docs/design', 'docs/decisions', 'docs/proposals']
const ALLOWED = new Set([
  'README.md',
  'README.en.md',
  'CHANGELOG.md',
  'docs/README.md',
  'docs/decisions/ADR-0006-rename-runtime-identifiers.md',
  'docs/decisions/ADR-0007-i18n-layering.md',
  'scripts/check-boot-constraints.mjs',
])

function walk(relDir) {
  const out = []
  for (const entry of readdirSync(join(root, relDir), { withFileTypes: true })) {
    const rel = relDir + '/' + entry.name
    if (entry.isDirectory()) out.push(...walk(rel))
    else out.push(rel)
  }
  return out
}

const scanned = SCAN_ROOTS.flatMap((rel) => (existsSync(join(root, rel)) ? walk(rel) : []))
const legacyHits = []
for (const rel of scanned) {
  if (rel.startsWith('src/local/migration/')) continue
  if (ALLOWED.has(rel)) continue
  if (!/\.(ts|mjs|js|md|yml|json)$/.test(rel)) continue
  const text = readFileSync(join(root, rel), 'utf8')
  // 逐文件豁免：文件里显式写「legacy-name-ok」并说明理由（历史实拍证据 / 改名映射表）。
  // 比在脚本里维护路径白名单更难被悄悄扩大。
  if (text.includes('legacy-name-ok')) continue
  if (/teleport/i.test(text)) legacyHits.push(rel)
}
for (const rel of legacyHits) problems.push('旧名 teleport 出现在白名单之外：' + rel)

if (problems.length > 0) {
  for (const problem of problems) console.error('  ✗ ' + problem)
  console.error('check-boot-constraints: 失败（' + problems.length + ' 项）')
  process.exit(1)
}
console.log('check-boot-constraints: OK（行 id ' + ids.join(' / ') + '；' + notes.join('；') + '）')
