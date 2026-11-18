import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { LEGACY_HOME_DIR_NAME } from './migration/legacy-names.ts'
import { formatDoctorReport, runDoctor } from './doctor.ts'

/**
 * doctor 的用例都建在临时目录上：它查的就是「装出来的包能不能用」，
 * 用仓库自己的文件测等于把测试绑死在当前构建状态上。
 */
function makePackage(options: { main?: boolean; client?: boolean; patch?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'remote-cr-doctor-'))
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'dsh-remote-cr',
      version: '0.4.0',
      main: 'lib/index.js',
      exports: { '.': { default: './lib/index.js' }, './client': { default: './lib/client.js' } },
      dsh: { bundle: { patch: './cordis.patch.yml' }, engines: { dsh: '>=0.2.1-rc.0 <0.3.0' } },
    }),
    'utf8',
  )
  if (options.main !== false) writeFileSync(join(root, 'lib', 'index.js'), 'export {}\n', 'utf8')
  if (options.client !== false) writeFileSync(join(root, 'lib', 'client.js'), 'export {}\n', 'utf8')
  if (options.patch !== false) writeFileSync(join(root, 'cordis.patch.yml'), '- insert:\n    - id: remote-cr\n', 'utf8')
  return root
}

test('体检通过：入口、导出、浏览器半、补丁、状态根都在', () => {
  const root = makePackage()
  const home = mkdtempSync(join(tmpdir(), 'remote-cr-home-'))
  try {
    const checks = runDoctor({ rootDir: root, homeDir: home })
    const failed = checks.filter((check) => check.status === 'fail')
    assert.deepEqual(failed, [], '不该有 fail：' + JSON.stringify(failed))
    assert.ok(checks.some((check) => check.id === 'client-bundle' && check.status === 'ok'))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('缺入口就 fail —— 正是「lib/ 被 ignore 排除」那次事故的形状', () => {
  const root = makePackage({ main: false })
  const home = mkdtempSync(join(tmpdir(), 'remote-cr-home-'))
  try {
    const checks = runDoctor({ rootDir: root, homeDir: home })
    const entry = checks.find((check) => check.id === 'entry')
    assert.equal(entry?.status, 'fail')
    assert.match(entry?.detail ?? '', /lib\/index\.js/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('缺浏览器半与补丁分别给出可操作的 fail', () => {
  const root = makePackage({ client: false, patch: false })
  const home = mkdtempSync(join(tmpdir(), 'remote-cr-home-'))
  try {
    const checks = runDoctor({ rootDir: root, homeDir: home })
    assert.equal(checks.find((check) => check.id === 'client-bundle')?.status, 'fail')
    assert.equal(checks.find((check) => check.id === 'patch')?.status, 'fail')
    assert.match(formatDoctorReport(checks), /必须修/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('旧状态根只 warn，不 fail（能用，只是没清）', () => {
  const root = makePackage()
  const home = mkdtempSync(join(tmpdir(), 'remote-cr-home-'))
  mkdirSync(join(home, LEGACY_HOME_DIR_NAME), { recursive: true })
  try {
    const checks = runDoctor({ rootDir: root, homeDir: home })
    assert.equal(checks.find((check) => check.id === 'legacy-root')?.status, 'warn')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})
