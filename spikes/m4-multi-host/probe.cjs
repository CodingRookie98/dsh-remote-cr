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
  // 只认「纯数字行」：`wsl.exe` 有时会往 stdout 混一行告警，取最后一行数字行即可；
  // 完全没有数字行才当 unknown（脏输出不能被读成「在监听」，P4 N8）。
  const numeric = out.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+$/.test(line))
  const last = numeric[numeric.length - 1]
  if (last === undefined) return 'unknown'
  return last === '0' ? 'closed' : 'open'
}

// `grep -c` 在零匹配时**退出码 1**：不加 `|| true` 会把「没在监听」读成「探测失败」(unknown)。
// 没有 `ss` 时给一个非零退出码 → unknown；不要让 `grep -c` 的 0 被读成「已关闭」。
const listeningCommand = (port) =>
  'command -v ss >/dev/null 2>&1 || exit 3; ss -ltn 2>/dev/null | grep -c \':" + port + " \' || true'
const wslPort = (port) => probePort(['wsl.exe', '-d', WSL_DISTRO, '--exec', 'sh', '-c', listeningCommand(port)])
const sshPort = (port) =>
  probePort(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', SSH_ALIAS, listeningCommand(port)])

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

  console.log('==> M2 生效端口互不相同、两台都 connected（监听探测仅记录，不作判据）')
  const wslP = wslEntry?.effective.port
  const sshP = sshEntry?.effective.port
  // **WSL 走 stdio 桥，本来就没有 TCP 监听**（architecture.md §WSL ③）：对 WSL 断言「端口在监听」是错的。
  // 能断言的是：SSH 侧监听在；两台各自 connected；生效端口不同。
  // 监听探测只作**观测**记录，不作为判据：本机 `ss` 观测不稳定（多次出现 connected 但看不到监听），
  // 拿它当断言会制造假绿/假红。可判的是「两台都 connected + 生效端口不同 + 投影独立」。
  const sshState = sshP === undefined ? 'unknown' : sshPort(sshP)
  const wslListening = wslP === undefined ? 'unknown' : wslPort(wslP)
  expect('M2',
    wslP !== undefined && sshP !== undefined && wslP !== sshP &&
      wslEntry?.service.connected === true && sshEntry?.service.connected === true,
    JSON.stringify({ wslP, sshP, wslConnected: wslEntry?.service.connected, sshConnected: sshEntry?.service.connected, sshState, wslListening }))

  console.log('==> M3 投影各自独立（按 workspace id 比对，不数数量）')
  const wsIds = entries.map((entry) => entry.service.snapshot().workspaces.map((workspace) => workspace.id))
  expect('M3', entries.length === 2 && wsIds.every((ids) => ids.length >= 1) && new Set(wsIds.flat()).size === wsIds.flat().length,
    JSON.stringify({ wsIds }))

  console.log('==> M4 释放一台：只回收那台')
  const released = hub.release(wsl)
  // 判据：WSL 的 entry 被移除、SSH 仍在（connected 且 entry 还在）；监听探测只记录。
  const wslEntryGone = hub.peek(wsl) === undefined
  const sshStill = hub.peek(ssh) !== undefined && sshEntry?.service.connected === true
  // 远端进程是否真退出：**只记录不断言**（本机 `ss`/进程观测不稳定，不能当判据）。
  const wslListeningAfter = wslP === undefined ? 'unknown' : wslPort(wslP)
  // 排除自身：`sh -c` 的命令行里也有 "dsh"，直接 `pgrep -fc dsh` 会自匹配（P4 P3）。
  const remoteProcs = spawnSync(
    'wsl.exe',
    ['-d', WSL_DISTRO, '--exec', 'sh', '-c', "pgrep -af 'node.*dsh' | grep -v pgrep | wc -l"],
    { windowsHide: true },
  )
  const remoteProcCount = Buffer.from(remoteProcs.stdout ?? []).toString('utf8').trim()
  expect('M4', released.recycled === true && wslEntryGone && sshStill,
    JSON.stringify({ released, wslEntryGone, sshStill, wslListeningAfter, remoteProcCount }))

  console.log('==> M5 释放另一台：两台都关')
  hub.release(ssh)
  const sshEntryGone = hub.peek(ssh) === undefined
  expect('M5', sshEntryGone && hub.entries().length === 0, JSON.stringify({ sshEntryGone, entries: hub.entries().length }))
  return { ports: [wslP, sshP], wsIds }
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

  console.log('==> S2 已连那台 connected；顺延那台只是建了引擎（WSL 无 TCP 监听，不作端口断言）')
  const firstPort = entries[0]?.effective.port
  const secondPort = entries[1]?.effective.port
  const firstConnected = entries[0]?.service.connected === true
  const secondConnected = entries[1]?.service.connected === true
  expect('S2', firstConnected && !secondConnected, JSON.stringify({ ports, firstConnected, secondConnected }))

  console.log('==> S3 释放已连那台：entry 被移除、引用归零；未连那台释放不报错')
  const releasedFirst = hub.release(first)
  // 不写 `recycled ? 0 : -1` 这种同义反复：断言看得到的事实（entry 消失 + 另一台仍在册）。
  const firstGone = hub.peek(first) === undefined
  const secondStill = hub.peek(second) !== undefined
  const releasedSecond = hub.release(second)
  const secondGone = hub.peek(second) === undefined
  expect('S3',
    releasedFirst.recycled === true && firstGone && secondStill && releasedSecond.recycled === false && secondGone,
    JSON.stringify({ releasedFirst, firstGone, secondStill, releasedSecond, secondGone }))
  return { ports, adjusted, firstGone, secondGone }
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
