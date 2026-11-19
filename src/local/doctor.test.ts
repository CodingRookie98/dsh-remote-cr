import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { LEGACY_HOME_DIR_NAME } from './migration/legacy-names.ts'
import { formatDoctorReport, packageRootOf, resolveHome, runDoctor } from './doctor.ts'

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

test('resolveHome：空串等于未设置，回退到 os.homedir()（P4 Delta N2）', () => {
  const fallback = (): string => '/fallback-home'
  assert.equal(resolveHome({ USERPROFILE: 'C:/Users/hui', HOME: '/home/hui' }, fallback), 'C:/Users/hui')
  assert.equal(resolveHome({ USERPROFILE: '', HOME: '/home/hui' }, fallback), '/home/hui', '空串不许当成有效值')
  assert.equal(resolveHome({ USERPROFILE: '', HOME: '' }, fallback), '/fallback-home', '两个都空 → 系统 home')
  assert.equal(resolveHome({}, fallback), '/fallback-home')
})

test('packageRootOf：源码与产物两种布局都落到包根（P4 建议 3）', () => {
  // 生产跑的是 `lib/local/doctor.js`；只测 `src/local/doctor.ts` 等于没测发布的层级数学。
  const root = mkdtempSync(join(tmpdir(), 'remote-cr-root-'))
  try {
    // Windows 上盘符大小写会被 pathToFileURL/fileURLToPath 归一，比较前统一小写。
    const norm = (value: string): string => resolve(value).toLowerCase()
    const asLib = packageRootOf(pathToFileURL(join(root, 'lib', 'local', 'doctor.js')).href)
    const asSrc = packageRootOf(pathToFileURL(join(root, 'src', 'local', 'doctor.ts')).href)
    assert.equal(norm(asLib), norm(root), '产物布局：lib/local 的上两级 = 包根')
    assert.equal(norm(asSrc), norm(root), '源码布局：src/local 的上两级 = 包根')
    assert.equal(norm(asLib), norm(asSrc), '两种布局必须推出同一个包根')
    // 多一级就落到更浅一层：证明是「上两级」而不是猜出来的
    const deeper = packageRootOf(pathToFileURL(join(root, 'lib', 'local', 'deeper', 'doctor.js')).href)
    // deeper/doctor.js 的上两级 = lib（local 的上一级），与包根不同 —— 说明确实是「上两级」。
    assert.equal(norm(deeper), norm(join(root, 'lib')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
