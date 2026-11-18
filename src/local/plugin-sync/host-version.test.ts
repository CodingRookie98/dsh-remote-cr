import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { findHostVersion, HOST_PACKAGE_NAME, localHostVersion } from './host-version.ts'

/** L1：本地宿主版本查找（假 fs，不碰真盘）。 */

function reader(files: Record<string, string>): (file: string) => string {
  return (file) => {
    const hit = files[file.replace(/\\/g, '/')]
    if (hit === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return hit
  }
}

test('从入口向上找到宿主包（name 对得上才认）', () => {
  const files = {
    '/w/dsh/apps/cli/package.json': JSON.stringify({ name: HOST_PACKAGE_NAME, version: '0.2.2-rc.4' }),
    '/w/dsh/apps/package.json': JSON.stringify({ name: '@deepseek-ai/dsh-apps', version: '9.9.9' }),
    '/w/dsh/package.json': JSON.stringify({ name: 'deepseek-harness', version: '1.0.0' }),
  }
  const found = findHostVersion('/w/dsh/apps/cli/lib/bin.js', { readFile: reader(files) })
  assert.equal(found, '0.2.2-rc.4', '必须认 name，不能把兄弟包或仓库根当成宿主')
})

test('同层优先：离入口最近的宿主包胜出', () => {
  const files = {
    '/w/dsh/apps/cli/lib/package.json': JSON.stringify({ name: HOST_PACKAGE_NAME, version: '0.2.2-rc.4' }),
    '/w/dsh/package.json': JSON.stringify({ name: HOST_PACKAGE_NAME, version: '0.9.9' }),
  }
  assert.equal(findHostVersion('/w/dsh/apps/cli/lib/bin.js', { readFile: reader(files) }), '0.2.2-rc.4')
})

test('读不到 / 坏 JSON / 版本为空 → null（上层据此给 local-version-unknown，不猜）', () => {
  assert.equal(findHostVersion('/nope/lib/bin.js', { readFile: reader({}) }), null)
  const bad = { '/nope/package.json': '{oops' }
  assert.equal(findHostVersion('/nope/lib/bin.js', { readFile: reader(bad) }), null)
  const empty = { '/nope/package.json': JSON.stringify({ name: HOST_PACKAGE_NAME, version: '' }) }
  assert.equal(findHostVersion('/nope/lib/bin.js', { readFile: reader(empty) }), null)
})

test('接线门禁：index.ts 必须把本进程的宿主版本传给同步接线（否则永远 local-version-unknown）', () => {
  const source = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8')
  assert.match(source, /createSyncRoutesOptions\(\{[^}]*hostVersion: localHostVersion\(\)/, '宿主版本必须来自本进程，不是配置项')
})

/**
 * 产物门禁：插件运行时加载的是 `lib/`。只改 `src/index.ts` 不重建，就等于什么都没做
 * （R1 BLK-1：src 已接线、lib/index.js 里 grep 不到 hostVersion，功能在生产上是死路）。
 */
test('产物门禁：lib/index.js 也带 hostVersion 接线（只改 src 会红）', () => {
  const built = readFileSync(join(process.cwd(), 'lib/index.js'), 'utf8')
  assert.match(built, /hostVersion/, 'lib/index.js 必须重建过：pnpm build 后再提交')
})

test('localHostVersion：没有 argv[1] 时直接 null，不读盘', () => {
  assert.equal(localHostVersion([]), null)
  assert.equal(localHostVersion(['node']), null)
})
