#!/usr/bin/env node
/**
 * 跨后端同机验证（RFC-0007 未验证项 3）。
 *
 * 场景：WSL 后端与 SSH 后端指向**同一台物理机**（WSL 在 Ubuntu 上，SSH 也用本机别名连进去）。
 * `sameHostOf()` 是**按后端分组**判同机的，跨后端一律返回 false ——
 * 于是两个 target 会拿到同一个端口数字，而远端 dsh 抢的是同一台机器的同一个 127.0.0.1 端口。
 *
 * 本探针要测的是：**真的会撞吗？撞了之后表现是什么？**（不假设，只观测）
 */
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const { pathToFileURL } = require('node:url')

const DISTRO = process.env.DSH_DISTRO ?? 'ubuntu_dev'
const ALIAS = process.env.DSH_SSH_ALIAS ?? 'syy_wsl_ubuntu_LAN'
const WSL_ROOT = process.env.DSH_REMOTE_ROOT ?? '/home/hui/workspace/tools/deepseek-harness'
const SSH_ROOT = process.env.DSH_SSH_ROOT ?? '/home/hui/workspace'
const PORT = 8953

let passed = 0
let failed = 0
const failures = []
function expect(name, ok, detail) {
  if (ok) { passed += 1; console.log('  PASS ' + name + (detail ? ' ' + detail : '')) }
  else { failed += 1; failures.push(name); console.log('  FAIL ' + name + (detail ? ' ' + detail : '')) }
}
const load = async (rel) => import(pathToFileURL(path.join(process.cwd(), rel)).href)

const wslRun = (cmd) => {
  const out = spawnSync('wsl.exe', ['-d', DISTRO, '--exec', 'sh', '-c', cmd], { windowsHide: true })
  return { code: out.status ?? -1, out: Buffer.from(out.stdout ?? []).toString('utf8').trim() }
}
const sshRun = (cmd) => {
  const out = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', ALIAS, cmd], { windowsHide: true })
  return { code: out.status ?? -1, out: Buffer.from(out.stdout ?? []).toString('utf8').trim() }
}

async function main() {
  const liveMod = await load('src/local/projection/live.ts')
  const serviceMod = await load('src/local/projection/service.ts')
  const storeMod = await load('src/local/projection/store.ts')
  const hubMod = await load('src/local/projection/hub.ts')

  console.log('==> X1 两个后端是不是同一台机器（用 machine-id 判，不看 hostname）')
  const wslId = wslRun('cat /etc/machine-id 2>/dev/null || cat /var/lib/dbus/machine-id 2>/dev/null || echo none').out
  const sshId = sshRun('cat /etc/machine-id 2>/dev/null || cat /var/lib/dbus/machine-id 2>/dev/null || echo none').out
  const sameMachine = wslId !== '' && wslId === sshId
  console.log('      wsl machine-id=' + wslId + ' ssh machine-id=' + sshId)
  expect('X1', wslId !== 'none' && sshId !== 'none', JSON.stringify({ sameMachine }))

  console.log('==> X2 sameHostOf 对这两个 target 判成不同主机（已知盲区）')
  const wsl = { backend: 'wsl', distro: DISTRO, port: PORT, remoteRoot: WSL_ROOT }
  const ssh = { backend: 'ssh', alias: ALIAS, port: PORT, remoteRoot: SSH_ROOT }
  const sameHost = hubMod.sameHostOf(wsl, ssh)
  expect('X2', sameHost === false, JSON.stringify({ sameHost, sameMachine }))

  const hub = new hubMod.ProjectionHub(
    () =>
      new serviceMod.ProjectionService({
        store: new storeMod.ProjectionStore(),
        connect: liveMod.createLiveConnect({ launchTimeoutMs: 120000, ssh: { homeDir: process.env.USERPROFILE ?? '', authFor: async () => ({ kind: 'key' }) } }),
      }),
  )
  const localOf = (root) => '\\\\wsl.localhost\\' + DISTRO + root.split('/').join('\\')

  console.log('==> X3 先接 SSH，再接同端口的 WSL：容器会不会给出同一个端口')
  let sshError
  try { await hub.attach(ssh, { remotePath: SSH_ROOT, localPath: 'C:/Temp/xsame/ssh', title: 'ssh' }) } catch (e) { sshError = e }
  const sshEntry = hub.entries().find((entry) => entry.target.backend === 'ssh')
  let wslError
  try { await hub.attach(wsl, { remotePath: WSL_ROOT, localPath: localOf(WSL_ROOT), title: 'wsl' }) } catch (e) { wslError = e }
  const wslEntry = hub.entries().find((entry) => entry.target.backend === 'wsl')
  const ports = hub.entries().map((entry) => entry.effective.port)
  console.log('      sshErr=' + (sshError && (sshError.code ?? sshError.message)) +
    ' wslErr=' + (wslError && (wslError.code ?? wslError.message)) + ' ports=' + JSON.stringify(ports))
  expect('X3', ports.length === 2 && new Set(ports).size === 1,
    JSON.stringify({ ports, sameMachine, note: '跨后端不避让 → 同一个端口数字是预期' }))

  console.log('==> X4 真机上那个端口有几个 dsh 在监听（同机撞端口的真实代价）')
  const listeners = sshRun("ss -ltn 2>/dev/null | grep -c ':" + PORT + " ' || true").out
  console.log('      listeners=' + listeners)
  expect('X4', true, JSON.stringify({ listeners, sshConnected: sshEntry?.service.connected, wslConnected: wslEntry?.service.connected }))

  hub.disposeAll()

  console.log('==> X5 同一后端同一台机（SSH 同别名、同端口）必须避让')
  const hub2 = new hubMod.ProjectionHub(
    () =>
      new serviceMod.ProjectionService({
        store: new storeMod.ProjectionStore(),
        connect: liveMod.createLiveConnect({ launchTimeoutMs: 120000, ssh: { homeDir: process.env.USERPROFILE ?? '', authFor: async () => ({ kind: 'key' }) } }),
      }),
  )
  const a = { backend: 'ssh', alias: ALIAS, port: PORT, remoteRoot: SSH_ROOT }
  const b = { backend: 'ssh', alias: ALIAS, port: PORT, remoteRoot: '/home/hui' }
  let aErr, bErr
  try { await hub2.attach(a, { remotePath: SSH_ROOT, localPath: 'C:/Temp/xsame/a', title: 'a' }) } catch (e) { aErr = e }
  try { await hub2.attach(b, { remotePath: '/home/hui', localPath: 'C:/Temp/xsame/b', title: 'b' }) } catch (e) { bErr = e }
  const aPort = hub2.entries()[0]?.effective.port
  const bPort = hub2.entries()[1]?.effective.port
  const aAdjusted = hub2.entries()[0]?.portAdjusted
  const bAdjusted = hub2.entries()[1]?.portAdjusted
  console.log('      aErr=' + (aErr && (aErr.code ?? aErr.message)) + ' bErr=' + (bErr && (bErr.code ?? bErr.message)) +
    ' ports=' + JSON.stringify([aPort, bPort]) + ' adjusted=' + JSON.stringify([aAdjusted, bAdjusted]))
  expect('X5', aPort !== undefined && bPort !== undefined && aPort !== bPort && bAdjusted === true,
    JSON.stringify({ aPort, bPort, aAdjusted, bAdjusted }))

  console.log('==> X6 远端上两个端口各有一个 dsh 在监听（真机证据）')
  // 分开数：一条命令里塞 `grep -E` 的引号很容易被 shell 吃掉（上一版就是这么假绿的）。
  const countOf = (port) => sshRun("ss -ltn 2>/dev/null | grep -c ':" + String(port) + " ' || true").out
  const aOn = countOf(aPort)
  const bOn = countOf(bPort)
  console.log('      listeners: ' + String(aPort) + '=' + aOn + ' ' + String(bPort) + '=' + bOn)
  // **只记录不断言**：SSH 后端的 target 端口是**本地隧道口**，远端 dsh 的监听口不必然等于它
  // （`8953=0 / 8941=1` 就是实测结果）。把它写成断言等于赌一个未经验证的映射关系。
  expect('X6', true, JSON.stringify({ note: '监听数只记录', aPort, bPort, aOn, bOn }))
  hub2.disposeAll()

  mkdirSync('spikes/m4-multi-host', { recursive: true })
  writeFileSync('spikes/m4-multi-host/cross-backend.json', JSON.stringify({
    sameMachine, wslId, sshId, sameHost, ports,
    sshError: sshError && (sshError.code ?? sshError.message),
    wslError: wslError && (wslError.code ?? wslError.message),
    listeners, aOn, bOn, sameBackendAvoid: [aPort, bPort], passed, failed, failures, at: new Date().toISOString(),
  }, null, 2) + '\n')
  console.log('\n跨后端探针：通过 ' + passed + ' / 失败 ' + failed + (failed === 0 ? '' : ' → ' + failures.join(',')))
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => { console.error('probe crashed: ' + (error && error.stack ? error.stack : error)); process.exit(2) })
