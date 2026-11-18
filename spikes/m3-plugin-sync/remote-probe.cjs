#!/usr/bin/env node
/**
 * RFC-0003 / T4 真机探针：一次往返拿到「远端清单 + 运行时」，并算出差集。
 *
 * 断言：
 *   S-1  alias 能在 ~/.ssh/config 里解析成 SshTarget
 *   S-2  readRemoteProfile 成功，且 runtime 非空（node/dsh 真实路径都在）
 *   S-3  差集里 install 项数量 >= 1（真机样本：本地 6 个第三方、远端 0 个）
 *   S-4  install 项的 localVersion 都是确切版本（不是 latest / null）
 *
 * 用法：node spikes/m3-plugin-sync/remote-probe.cjs [alias] [remoteRoot]
 */
const path = require('node:path')
const os = require('node:os')
const { pathToFileURL } = require('node:url')

const ALIAS = process.argv[2] ?? 'syy_wsl_ubuntu_LAN'
const REMOTE_ROOT = process.argv[3] ?? '/home/hui/workspace'
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ''

let passed = 0
let failed = 0
const failures = []
function expect(name, ok, detail) {
  if (ok) { passed += 1; console.log('  PASS ' + name + (detail === undefined ? '' : ' ' + detail)) }
  else { failed += 1; failures.push(name); console.log('  FAIL ' + name + (detail === undefined ? '' : ' ' + detail)) }
}

async function load(rel) {
  return import(pathToFileURL(path.join(process.cwd(), rel)).href)
}

async function main() {
  const { createSyncRoutesOptions } = await load('src/local/plugin-sync/wire.ts')
  const { readRemoteProfile } = await load('src/local/plugin-sync/read.ts')
  const { readLocalBundles } = await load('src/local/plugin-sync/local.ts')
  const { diffBundles, planTotals } = await load('src/shared/plugin-sync.ts')

  const sync = createSyncRoutesOptions({ homeDir: HOME })
  const target = { backend: 'ssh', alias: ALIAS, port: 22, remoteRoot: REMOTE_ROOT }
  let backend
  let resolveError
  try {
    backend = await sync.resolve(target)
  } catch (error) {
    resolveError = error
  }
  expect('S-1', backend !== undefined, JSON.stringify({ error: resolveError && (resolveError.code ?? resolveError.message) }))
  if (backend === undefined) return

  const started = Date.now()
  let profile
  let readError
  try {
    profile = await readRemoteProfile({ exec: backend.exec, nodeCommand: backend.nodeCommand, homeDir: '', profile: 'web' })
  } catch (error) {
    readError = error
  }
  const ms = Date.now() - started
  expect('S-2', profile !== undefined && profile.runtime !== null, JSON.stringify({
    error: readError && (readError.code ?? readError.message),
    ms,
    runtime: profile && profile.runtime,
    bundles: profile && profile.bundles.length,
  }))
  if (profile === undefined) return

  const local = readLocalBundles({ profileDir: path.join(HOME, '.dsh', 'profiles', 'web') })
  const entries = diffBundles({ local, remote: profile.bundles })
  const totals = planTotals(entries)
  const installs = entries.filter((entry) => entry.action === 'install')
  expect('S-3', totals.install >= 1, JSON.stringify({ totals, names: installs.map((entry) => entry.name) }))
  expect(
    'S-4',
    installs.every((entry) => typeof entry.localVersion === 'string' && entry.localVersion !== '' && entry.localVersion !== 'latest'),
    JSON.stringify(installs.map((entry) => entry.name + '@' + entry.localVersion)),
  )

  console.log('')
  console.log('--- ' + passed + '/' + (passed + failed) + ' passed, ' + failed + ' failed ---')
  if (failed > 0) { console.log('failed=' + JSON.stringify(failures)); process.exitCode = 1 }
}

main().catch((error) => { console.error('探针异常：' + (error && error.stack ? error.stack : String(error))); process.exitCode = 1 })
