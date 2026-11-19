#!/usr/bin/env node
/**
 * RFC-0007 A3 真机取证。两种模式：
 *   --cross-host（默认）WSL + SSH 两台不同机器同时在线；释放一台只回收那台。
 *   --same-host       同一 WSL distro 的两个目录、同一端口 → 第二个必须被顺延（真正走 reserveAvoiding）。
 *
 * 判据只用**实际生效端口**（`entry.effective.port`），不用请求端口；端口探测三态
 * （open/closed/unknown），远端不可达时不会被读成「已关闭」（P4 B7 的假绿）。
 */
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const { pathToFileURL } = require('node:url')

const SAME_HOST = process.argv.includes('--same-host')
const HOME_DIR = process.env.USERPROFILE ?? process.env.HOME ?? ''
const WSL_DISTRO = process.env.DSH_DISTRO ?? 'ubuntu_dev'
const WSL_ROOT = process.env.DSH_REMOTE_ROOT ?? '/home/hui/workspace/tools/deepseek-harness'
const SSH_ALIAS = process.env.DSH_SSH_ALIAS ?? 'syy_wsl_ubuntu_LAN'
const SSH_ROOT = process.env.DSH_SSH_ROOT ?? '/home/hui/workspace'
const WSL_PORT = 8960
const SSH_PORT = 8961
const SAME_PORT = 8959

let passed = 0
let failed = 0
const failures = []

function expect(name, ok, detail) {
  if (ok) { passed += 1; console.log('  PASS ' + name + (detail ? ' ' + detail : '')) }
  else { failed += 1; failures.push(name); console.log('  FAIL ' + name + (detail ? ' ' + detail : '')) }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const load = async (rel) => import(pathToFileURL(path.join(process.cwd(), rel)).href)

function probePort(command) {
  const result = spawnSync(command[0], command.slice(1), { windowsHide: true })
  if (result.status !== 0) return 'unknown'
  const out = Buffer.from(result.stdout ?? []).toString('utf8').trim()
  if (out === '') return 'unknown'
  return out === '0' ? 'closed' : 'open'
}

// `grep -c` 在零匹配时**退出码 1**：不加 `|| true` 会把「没在监听」读成「探测失败」(unknown)。
const listeningCommand = (port) => "ss -ltn 2>/dev/null | grep -c ':" + port + " ' || true"
const wslPort = (port) => probePort(['wsl.exe', '-d', WSL_DISTRO, '--exec', 'sh', '-c', listeningCommand(port)])
const sshPort = (port) =>
  probePort(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', SSH_ALIAS, listeningCommand(port)])

async function waitClosed(check, budgetMs) {
  const start = Date.now()
  while (Date.now() - start < budgetMs) {
    const state = check()
    if (state === 'closed') return Date.now() - start
    if (state === 'unknown') return -1
    await sleep(250)
  }
  return -1
}

async function buildHub() {
  const liveMod = await load('src/local/projection/live.ts')
  const serviceMod = await load('src/local/projection/service.ts')
  const storeMod = await load('src/local/projection/store.ts')
  const hubMod = await load('src/local/projection/hub.ts')
  return new hubMod.ProjectionHub(
    () =>
      new serviceMod.ProjectionService({
        store: new storeMod.ProjectionStore(),
        connect: liveMod.createLiveConnect({
          launchTimeoutMs: 90000,
          ssh: { homeDir: HOME_DIR, authFor: async () => ({ kind: 'key' }) },
        }),
      }),
  )
}

async function crossHost(hub) {
  const wsl = { backend: 'wsl', distro: WSL_DISTRO, port: WSL_PORT, remoteRoot: WSL_ROOT }
  const ssh = { backend: 'ssh', alias: SSH_ALIAS, port: SSH_PORT, remoteRoot: SSH_ROOT }
  const wslLocal = '\\\\wsl.localhost\\' + WSL_DISTRO + WSL_ROOT.split('/').join('\\')

  console.log('==> M1 两台同时 attach')
  let wslError, sshError
  try { await hub.attach(wsl, { remotePath: WSL_ROOT, localPath: wslLocal, title: 'wsl' }) } catch (error) { wslError = error }
  try { await hub.attach(ssh, { remotePath: SSH_ROOT, localPath: 'C:/Temp/m4-multi/ssh', title: 'ssh' }) } catch (error) { sshError = error }
  const entries = hub.entries()
  const wslEntry = entries.find((entry) => entry.target.backend === 'wsl')
  const sshEntry = entries.find((entry) => entry.target.backend === 'ssh')
  expect('M1', entries.length === 2 && entries.every((entry) => entry.service.connected),
    JSON.stringify({ entries: entries.length, connected: entries.map((entry) => entry.service.connected),
      wslErr: wslError && (wslError.code ?? wslError.message), sshErr: sshError && (sshError.code ?? sshError.message) }))

  console.log('==> M2 生效端口互不相同，且各自真的在监听')
  const wslP = wslEntry?.effective.port
  const sshP = sshEntry?.effective.port
  const wslState = wslP === undefined ? 'unknown' : wslPort(wslP)
  const sshState = sshP === undefined ? 'unknown' : sshPort(sshP)
  expect('M2', wslP !== undefined && sshP !== undefined && wslP !== sshP && wslState === 'open' && sshState === 'open',
    JSON.stringify({ wslP, sshP, wslState, sshState }))

  console.log('==> M3 投影各自独立（按 workspace id 比对，不数数量）')
  const wsIds = entries.map((entry) => entry.service.snapshot().workspaces.map((workspace) => workspace.id))
  expect('M3', entries.length === 2 && wsIds.every((ids) => ids.length >= 1) && new Set(wsIds.flat()).size === wsIds.flat().length,
    JSON.stringify({ wsIds }))

  console.log('==> M4 释放一台：只回收那台')
  const released = hub.release(wsl)
  const wslClosedIn = wslP === undefined ? -1 : await waitClosed(() => wslPort(wslP), 5000)
  const sshStill = sshP !== undefined && sshPort(sshP) === 'open' && sshEntry?.service.connected === true
  expect('M4', released.recycled === true && wslClosedIn >= 0 && sshStill,
    JSON.stringify({ released, wslClosedIn, sshStill }))

  console.log('==> M5 释放另一台：两台都关')
  hub.release(ssh)
  const sshClosedIn = sshP === undefined ? -1 : await waitClosed(() => sshPort(sshP), 5000)
  expect('M5', sshClosedIn >= 0, JSON.stringify({ sshClosedIn }))
  return { ports: [wslP, sshP], wslClosedIn, sshClosedIn, wsIds }
}

async function sameHost(hub) {
  console.log('==> S1 同一 distro、同端口、不同目录：第二个引擎必须被顺延')
  const first = { backend: 'wsl', distro: WSL_DISTRO, port: SAME_PORT, remoteRoot: WSL_ROOT }
  const second = { backend: 'wsl', distro: WSL_DISTRO, port: SAME_PORT, remoteRoot: '/home/hui' }
  const localOf = (root) => '\\\\wsl.localhost\\' + WSL_DISTRO + root.split('/').join('\\')
  let firstError
  try { await hub.attach(first, { remotePath: WSL_ROOT, localPath: localOf(WSL_ROOT), title: 'a' }) } catch (error) { firstError = error }
  // 第二台**只建引擎、不 attach**：`/home/hui` 上没有 dsh 检出，真连会在启动阶段失败，
  // 那验的是「没装 dsh」而不是端口顺延。端口顺延发生在建引擎这一步，建出来就能断言。
  hub.serviceFor(second)
  const entries = hub.entries()
  const ports = entries.map((entry) => entry.effective.port)
  const adjusted = entries.map((entry) => entry.portAdjusted)
  expect('S1', entries.length === 2 && new Set(ports).size === 2 && adjusted.includes(true) && firstError === undefined,
    JSON.stringify({ ports, adjusted, firstErr: firstError && (firstError.code ?? firstError.message) }))

  console.log('==> S2 真正连上的那台端口在监听；顺延出来的那台没有监听（没 attach）')
  const firstPort = entries[0]?.effective.port
  const secondPort = entries[1]?.effective.port
  const states = [firstPort === undefined ? 'unknown' : wslPort(firstPort), secondPort === undefined ? 'unknown' : wslPort(secondPort)]
  expect('S2', states[0] === 'open' && states[1] === 'closed', JSON.stringify({ ports, states }))

  console.log('==> S3 释放已连那台：它的端口关闭；未连那台释放不报错')
  const releasedFirst = hub.release(first)
  const closedFirst = firstPort === undefined ? -1 : await waitClosed(() => wslPort(firstPort), 5000)
  const releasedSecond = hub.release(second)
  expect('S3', releasedFirst.recycled === true && closedFirst >= 0 && releasedSecond.recycled === false,
    JSON.stringify({ releasedFirst, closedFirst, releasedSecond }))
  return { ports, adjusted, closedFirst }
}

async function main() {
  const hub = await buildHub()
  const result = SAME_HOST ? await sameHost(hub) : await crossHost(hub)
  hub.disposeAll()
  mkdirSync('spikes/m4-multi-host', { recursive: true })
  writeFileSync('spikes/m4-multi-host/measurements-' + (SAME_HOST ? 'same-host' : 'cross-host') + '.json', JSON.stringify({
    mode: SAME_HOST ? 'same-host' : 'cross-host', passed, failed, failures, result, at: new Date().toISOString(),
  }, null, 2) + '\n')
  console.log('\n多 host 探针：通过 ' + passed + ' / 失败 ' + failed + (failed === 0 ? '' : ' → ' + failures.join(',')))
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => { console.error('probe crashed: ' + (error && error.stack ? error.stack : error)); process.exit(2) })
