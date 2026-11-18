#!/usr/bin/env node
/**
 * RFC-0003 / T4 真机探针：一次往返拿到「远端清单 + 运行时」，并算出差集。
 *
 * 两种模式（同一个 wire → read → diff 链路，只有执行面不同）：
 *   node spikes/m3-plugin-sync/remote-probe.cjs [alias] [remoteRoot]            # SSH
 *   node spikes/m3-plugin-sync/remote-probe.cjs --wsl [distro] [checkoutRoot]   # WSL
 *
 * 注意（Windows）：MSYS/Git-Bash 会把**裸的 `/home/...` 参数**改成 `C:/...`，探针会拿错根目录。
 * 走 WSL 时请改用环境变量：`DSH_DISTRO=ubuntu_dev DSH_REMOTE_ROOT=/home/hui/<checkout> node … --wsl`。
 *
 * 断言：
 *   S-1  target 能解析出 SyncBackend（WSL 分支曾经直接拒绝 plugin-sync-unsupported）
 *   S-2  readRemoteProfile 成功，runtime 非空（WSL 走检出形态：dshCommand/interpreter 都在）
 *   S-3  差集里 install 项数量 >= 1
 *   S-4  install 项的 localVersion 都是确切版本（不是 latest / null）
 *   S-5  仅当 REMOTE_CR_PROBE_APPLY=1：真的装第一条，再读一次必须少一项（写路径实证）
 *
 * 说明：S-5 会改远端 profile（装的就是同步本来要装的那一条），幂等，可重跑。
 */
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ARGS = process.argv.slice(2)
const MODE = ARGS[0] === '--wsl' ? 'wsl' : 'ssh'
const DSH_DISTRO = process.env.DSH_DISTRO ?? 'ubuntu_dev'
const DSH_CHECKOUT = process.env.DSH_REMOTE_ROOT ?? '/home/hui/workspace/tools/deepseek-harness'
const ALIAS = MODE === 'ssh' ? ARGS[0] ?? 'syy_wsl_ubuntu_LAN' : ''
const DISTRO = MODE === 'wsl' ? ARGS[1] ?? DSH_DISTRO : ''
const REMOTE_ROOT = MODE === 'ssh' ? ARGS[1] ?? '/home/hui/workspace' : ARGS[2] ?? DSH_CHECKOUT
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
  const { applySyncPlan } = await load('src/local/plugin-sync/service.ts')
  const { diffBundles, planTotals } = await load('src/shared/plugin-sync.ts')

  const sync = createSyncRoutesOptions({ homeDir: HOME })
  const target =
    MODE === 'wsl'
      ? { backend: 'wsl', distro: DISTRO, port: 8899, remoteRoot: REMOTE_ROOT }
      : { backend: 'ssh', alias: ALIAS, port: 22, remoteRoot: REMOTE_ROOT }
  console.log('probe: mode=' + MODE + ' target=' + JSON.stringify(target))

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
    profile = await readRemoteProfile({
      exec: backend.exec,
      nodeCommand: backend.nodeCommand,
      homeDir: '',
      profile: 'web',
      ...(backend.checkoutRoot === undefined ? {} : { checkoutRoot: backend.checkoutRoot }),
    })
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
  if (MODE === 'wsl') {
    expect(
      'S-2b',
      profile.runtime !== null && String(profile.runtime.dshCommand).endsWith('/apps/cli/lib/bin.js') && profile.runtime.interpreter !== null,
      JSON.stringify({ dshCommand: profile.runtime && profile.runtime.dshCommand, interpreter: profile.runtime && profile.runtime.interpreter }),
    )
  }

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

  // ---- S-5：写路径实证（可选）----
  if (process.env.REMOTE_CR_PROBE_APPLY === '1' && installs.length > 0) {
    const one = installs[0]
    console.log('==> S-5 真的装一条：' + one.name + '@' + one.localVersion)
    const targetId = await sync.targetId(target)
    let results
    let applyError
    const applyStarted = Date.now()
    try {
      results = await applySyncPlan({
        backend,
        runtime: profile.runtime,
        targetId,
        entries: [one],
        deadlineMs: 300000,
      })
    } catch (error) {
      applyError = error
    }
    const applyMs = Date.now() - applyStarted
    expect('S-5a', results !== undefined && results.length === 1 && results[0].ok === true, JSON.stringify({
      error: applyError && (applyError.code ?? applyError.message),
      results,
      applyMs,
    }))
    if (results !== undefined) {
      const again = await readRemoteProfile({
        exec: backend.exec,
        nodeCommand: backend.nodeCommand,
        homeDir: '',
        profile: 'web',
        ...(backend.checkoutRoot === undefined ? {} : { checkoutRoot: backend.checkoutRoot }),
      })
      const after = planTotals(diffBundles({ local, remote: again.bundles }))
      expect('S-5b', after.install === totals.install - 1, JSON.stringify({ before: totals.install, after: after.install }))
    }
  } else if (installs.length > 0) {
    console.log('  info 写路径未跑（REMOTE_CR_PROBE_APPLY=1 才会真的装一条）：' + installs[0].name + '@' + installs[0].localVersion)
  }

  console.log('')
  console.log('--- ' + passed + '/' + (passed + failed) + ' passed, ' + failed + ' failed ---')
  if (failed > 0) { console.log('failed=' + JSON.stringify(failures)); process.exitCode = 1 }
}

main().catch((error) => { console.error('探针异常：' + (error && error.stack ? error.stack : String(error))); process.exitCode = 1 })
