#!/usr/bin/env node
/**
 * RFC-0007 A3 的真机取证：**两台远端同时在线**（WSL + SSH 各一个引擎），
 * 以及引用计数「最后一个引用才回收」。
 *
 * 断言：
 *   M1 两台都 attach 成功，各自 connected
 *   M2 两个引擎拿到不同端口（同主机撞端口才顺延；跨主机本来就不同端口，这里验的是各自独立）
 *   M3 各自投影里有自己的工作区（互不覆盖）
 *   M4 release 一次（引用 1→0）→ 该台回收、远端端口关闭；另一台不受影响
 *   M5 两台都释放后端口都关闭
 *
 * 跑法：node spikes/m4-multi-host/probe.cjs
 */
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const { pathToFileURL } = require('node:url')

const HOME_DIR = process.env.USERPROFILE ?? process.env.HOME ?? ''
const WSL_DISTRO = process.env.DSH_DISTRO ?? 'ubuntu_dev'
const WSL_ROOT = process.env.DSH_REMOTE_ROOT ?? '/home/hui/workspace/tools/deepseek-harness'
const SSH_ALIAS = process.env.DSH_SSH_ALIAS ?? 'syy_wsl_ubuntu_LAN'
const SSH_ROOT = process.env.DSH_SSH_ROOT ?? '/home/hui/workspace'
const WSL_PORT = 8960
const SSH_PORT = 8961

let passed = 0
let failed = 0
const failures = []

function expect(name, ok, detail) {
  if (ok) { passed += 1; console.log('  PASS ' + name + (detail ? ' ' + detail : '')) }
  else { failed += 1; failures.push(name); console.log('  FAIL ' + name + (detail ? ' ' + detail : '')) }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const load = async (rel) => import(pathToFileURL(path.join(process.cwd(), rel)).href)

function portOpen(command) {
  const result = spawnSync(command[0], command.slice(1), { windowsHide: true })
  const out = Buffer.from(result.stdout ?? []).toString('utf8').trim()
  return out !== '' && out !== '0'
}

const wslListening = (port) =>
  portOpen(['wsl.exe', '-d', WSL_DISTRO, '--exec', 'sh', '-c', "ss -ltn 2>/dev/null | grep -c ':" + port + " '"])
const sshListening = (port) =>
  portOpen(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', SSH_ALIAS, "ss -ltn 2>/dev/null | grep -c ':" + port + " '"])

async function waitClosed(check, budgetMs) {
  const start = Date.now()
  while (Date.now() - start < budgetMs) {
    if (!check()) return Date.now() - start
    await sleep(250)
  }
  return -1
}

async function main() {
  const liveMod = await load('src/local/projection/live.ts')
  const serviceMod = await load('src/local/projection/service.ts')
  const storeMod = await load('src/local/projection/store.ts')
  const hubMod = await load('src/local/projection/hub.ts')

  const hub = new hubMod.ProjectionHub(() => new serviceMod.ProjectionService({
    store: new storeMod.ProjectionStore(),
    connect: liveMod.createLiveConnect({ launchTimeoutMs: 90000, ssh: { homeDir: HOME_DIR, authFor: async () => ({ kind: 'key' }) } }),
  }))

  const wsl = { backend: 'wsl', distro: WSL_DISTRO, port: WSL_PORT, remoteRoot: WSL_ROOT }
  const ssh = { backend: 'ssh', alias: SSH_ALIAS, port: SSH_PORT, remoteRoot: SSH_ROOT }
  const wslLocal = '\\\\wsl.localhost\\' + WSL_DISTRO + WSL_ROOT.split('/').join('\\')

  console.log('==> M1 两台同时 attach')
  let wslError, sshError
  try { await hub.attach(wsl, { remotePath: WSL_ROOT, localPath: wslLocal, title: 'wsl' }) } catch (error) { wslError = error }
  try { await hub.attach(ssh, { remotePath: SSH_ROOT, localPath: 'C:/Temp/m4-multi/ssh', title: 'ssh' }) } catch (error) { sshError = error }
  const entries = hub.entries()
  expect('M1', entries.length === 2 && entries.every((entry) => entry.service.connected),
    JSON.stringify({ entries: entries.length, connected: entries.map((entry) => entry.service.connected),
      wslErr: wslError && (wslError.code ?? wslError.message), sshErr: sshError && (sshError.code ?? sshError.message) }))

  console.log('==> M2/M3 端口与投影各自独立')
  const ports = entries.map((entry) => entry.effective.port)
  expect('M2', ports.length === 2 && new Set(ports).size === 2, JSON.stringify({ ports }))
  const wsCounts = entries.map((entry) => entry.service.snapshot().workspaces.length)
  expect('M3', wsCounts.every((count) => count >= 1), JSON.stringify({ wsCounts }))

  console.log('==> M4 释放一台：只回收那一台')
  const released = hub.release(wsl)
  const wslClosedIn = await waitClosed(() => wslListening(WSL_PORT), 5000)
  const sshStill = entries[1] ? entries[1].service.connected && sshListening(SSH_PORT) : false
  expect('M4', released.recycled === true && wslClosedIn >= 0 && sshStill,
    JSON.stringify({ released, wslClosedIn, sshStill }))

  console.log('==> M5 释放另一台：两台都关')
  hub.release(ssh)
  const sshClosedIn = await waitClosed(() => sshListening(SSH_PORT), 5000)
  expect('M5', sshClosedIn >= 0, JSON.stringify({ sshClosedIn }))

  hub.disposeAll()
  mkdirSync('spikes/m4-multi-host', { recursive: true })
  writeFileSync('spikes/m4-multi-host/measurements.json', JSON.stringify({
    passed, failed, failures, ports, wsCounts, wslClosedIn, sshClosedIn, at: new Date().toISOString(),
  }, null, 2) + '\n')
  console.log('\n多 host 探针：通过 ' + passed + ' / 失败 ' + failed + (failed === 0 ? '' : ' → ' + failures.join(',')))
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => { console.error('probe crashed: ' + (error && error.stack ? error.stack : error)); process.exit(2) })
