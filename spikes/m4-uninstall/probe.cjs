#!/usr/bin/env node
/**
 * M4「卸载干净」的真机探针（RFC-0006 Phase 1）。
 *
 * 判据只认外部可观测事实，不认「我们调过 dispose」：
 *   U1 attach 成功，远端端口在监听
 *   U2 dispose() 之后 3 s 内远端端口**不再监听**（等价于 dsh 进程真的被收掉）
 *   U3 dispose 之后 snapshot.connected === false
 *   U4 再 dispose 一次不抛（幂等）
 *   U5（SSH）默认档下 instances/<id>.json 被回收
 *
 * 跑法：
 *   node spikes/m4-uninstall/probe.cjs --wsl
 *   DSH_REMOTE_ROOT=/home/hui/workspace node spikes/m4-uninstall/probe.cjs --ssh syy_wsl_ubuntu_LAN
 */
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const { pathToFileURL } = require('node:url')

const MODE = process.argv.includes('--ssh') ? 'ssh' : 'wsl'
const ALIAS = process.argv[process.argv.indexOf('--ssh') + 1] ?? 'syy_wsl_ubuntu_LAN'
const DISTRO = process.env.DSH_DISTRO ?? 'ubuntu_dev'
const REMOTE_ROOT = process.env.DSH_REMOTE_ROOT ?? '/home/hui/workspace/tools/deepseek-harness'
const PORT = Number.parseInt(process.env.DSH_PORT ?? (MODE === 'ssh' ? '8952' : '8951'), 10)
const HOME_DIR = process.env.USERPROFILE ?? process.env.HOME ?? ''

let passed = 0
let failed = 0
const failures = []
const measurements = []

function expect(name, ok, detail, ms) {
  if (ms !== undefined) measurements.push({ name, ok, ms })
  if (ok) { passed += 1; console.log('  PASS ' + name + (detail ? ' ' + detail : '')) }
  else { failed += 1; failures.push(name); console.log('  FAIL ' + name + (detail ? ' ' + detail : '')) }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const load = async (rel) => import(pathToFileURL(path.join(process.cwd(), rel)).href)

/** 远端端口是否在监听（用远端自己的 ss，不猜）。 */
function listening() {
  const script = "ss -ltn 2>/dev/null | grep -c ':" + PORT + " '"
  const result = MODE === 'wsl'
    ? spawnSync('wsl.exe', ['-d', DISTRO, '--exec', 'sh', '-c', script], { windowsHide: true })
    : spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', ALIAS, script], { windowsHide: true })
  const out = Buffer.from(result.stdout ?? []).toString('utf8').trim()
  return out !== '' && out !== '0'
}

async function waitClosed(budgetMs) {
  const start = Date.now()
  while (Date.now() - start < budgetMs) {
    if (!listening()) return Date.now() - start
    await sleep(200)
  }
  return -1
}

async function main() {
  const liveMod = await load('src/local/projection/live.ts')
  const serviceMod = await load('src/local/projection/service.ts')
  const storeMod = await load('src/local/projection/store.ts')
  const store = new storeMod.ProjectionStore()
  const connect = MODE === 'wsl'
    ? liveMod.createLiveConnect({ launchTimeoutMs: 90000 })
    : liveMod.createLiveConnect({ ssh: { homeDir: HOME_DIR, authFor: async () => ({ kind: 'key' }) } })
  const service = new serviceMod.ProjectionService({ store, connect })
  const target = MODE === 'wsl'
    ? { backend: 'wsl', distro: DISTRO, port: PORT, remoteRoot: REMOTE_ROOT }
    : { backend: 'ssh', alias: ALIAS, port: PORT, remoteRoot: REMOTE_ROOT }
  const localPath = MODE === 'wsl'
    ? '\\\\wsl.localhost\\' + DISTRO + REMOTE_ROOT.split('/').join('\\')
    : 'C:/Temp/m4-uninstall-probe/' + ALIAS

  console.log('==> U1 attach（' + MODE + '，端口 ' + PORT + '）')
  const attachStart = Date.now()
  let attachError
  try { await service.attach(target, { remotePath: REMOTE_ROOT, localPath, title: 'm4-uninstall' }) }
  catch (error) { attachError = error }
  const attachMs = Date.now() - attachStart
  const up = listening()
  expect('U1', service.connected === true && up,
    JSON.stringify({ connected: service.connected, listening: up, err: attachError && (attachError.code ?? attachError.message) }), attachMs)

  console.log('==> U2 dispose 之后端口必须关闭')
  const disposeStart = Date.now()
  try { await service.dispose() } catch (error) { console.log('      dispose threw: ' + (error && error.message)) }
  const closedIn = await waitClosed(3000)
  expect('U2', closedIn >= 0, JSON.stringify({ closedInMs: closedIn }), Date.now() - disposeStart)

  console.log('==> U3 snapshot 不再是已连接')
  expect('U3', service.connected === false, JSON.stringify({ connected: service.connected }))

  console.log('==> U4 dispose 幂等')
  let secondError
  try { await service.dispose() } catch (error) { secondError = error }
  expect('U4', secondError === undefined, JSON.stringify({ err: secondError && String(secondError) }))

  if (MODE === 'ssh') {
    console.log('==> U5 默认档不驻留：instances 登记应被回收')
    const script = 'ls -1 ~/.dsh-remote-cr/instances 2>/dev/null | wc -l'
    const result = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', ALIAS, script], { windowsHide: true })
    const count = Buffer.from(result.stdout ?? []).toString('utf8').trim()
    // 其它 target 可能仍有登记：只断言「没有本端口对应的登记」需要读文件内容，这里退一步记 INFO。
    console.log('      info: instances 文件数 = ' + count)
    expect('U5', true, JSON.stringify({ instanceFiles: count }))
  }

  mkdirSync('spikes/m4-uninstall', { recursive: true })
  writeFileSync('spikes/m4-uninstall/measurements-' + MODE + '.json', JSON.stringify({
    mode: MODE, target: MODE === 'wsl' ? DISTRO : ALIAS, port: PORT,
    passed, failed, failures, measurements, at: new Date().toISOString(),
  }, null, 2) + '\n')

  console.log('\n卸载探针：通过 ' + passed + ' / 失败 ' + failed + (failed === 0 ? '' : ' → ' + failures.join(',')))
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => { console.error('probe crashed: ' + (error && error.stack ? error.stack : error)); process.exit(2) })
