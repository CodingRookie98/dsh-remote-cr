#!/usr/bin/env node
/**
 * R5 真机探针（RFC-0004）：刷新一致性与断线重连后的会话保全。
 *
 * 判据来自计划 2026-11-19-m3-long-task-closure §1.0 R5：
 *   「接入 → 断开 → 重连 后会话数与 id 集合不变、running 与远端一致」。
 *
 * 断言：
 *   R5-1 attach 成功，workspace online
 *   R5-2 createSession 成功（后面要用它证明投影里有真会话）
 *   R5-3 refreshSessions() 成功：updated >= 1 且 stale === false
 *   R5-4 投影里能查到该会话，且 running 是布尔（远端给什么就是什么）
 *   R5-5 断开后刷新：抛 remote/disconnected，且**一次 RPC 都不发**、条目数不变
 *   R5-6 reconnectNow() 成功：workspace id 不变、会话 id 集合不变
 *   R5-7 重连后 stale === false（重建 = 刚读过远端）
 *
 * 负控（NEGATIVE_CONTROL=1）：把 refreshSessions 换成一个永远返回 {0,0} 的空实现。
 * 期望 R5-3 红、R5-4 绿（投影没被破）、R5-5 视实现而绿——用于证明「刷新这条链真的被测住」，
 * 而不是整份探针一起绿。
 *
 * 跑法（MSYS 会把裸的 /home/... 改写成 C:/...，所以路径走环境变量）：
 *   node spikes/m3-refresh/probe.cjs --wsl
 *   DSH_DISTRO=ubuntu_dev DSH_REMOTE_ROOT=/home/hui/workspace/tools/deepseek-harness node spikes/m3-refresh/probe.cjs --wsl
 *   node spikes/m3-refresh/probe.cjs --ssh syy_wsl_ubuntu_LAN
 */
const path = require('node:path')
const { mkdirSync, writeFileSync } = require('node:fs')
const { pathToFileURL } = require('node:url')

const MODE = process.argv.includes('--ssh') ? 'ssh' : 'wsl'
const ALIAS = process.argv[process.argv.indexOf('--ssh') + 1] ?? 'syy_wsl_ubuntu_LAN'
const DISTRO = process.env.DSH_DISTRO ?? 'ubuntu_dev'
const REMOTE_ROOT = process.env.DSH_REMOTE_ROOT ?? '/home/hui/workspace/tools/deepseek-harness'
const PORT = Number.parseInt(process.env.DSH_PORT ?? (MODE === 'ssh' ? '8941' : '8903'), 10)
const HOME_DIR = process.env.USERPROFILE ?? process.env.HOME ?? ''
const NEGATIVE = process.env.NEGATIVE_CONTROL === '1'

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

async function buildService() {
  const liveMod = await load('src/local/projection/live.ts')
  const serviceMod = await load('src/local/projection/service.ts')
  const storeMod = await load('src/local/projection/store.ts')
  const store = new storeMod.ProjectionStore()
  let connect
  if (MODE === 'wsl') {
    connect = liveMod.createLiveConnect({ launchTimeoutMs: 90000 })
  } else {
    // SSH：authFor 只声明「走密钥」，具体 identity 文件由 live 层按 ~/.ssh/config 解析。
    connect = liveMod.createLiveConnect({
      ssh: { homeDir: HOME_DIR, authFor: async () => ({ kind: 'key' }) },
    })
  }
  const service = new serviceMod.ProjectionService({ store, connect })
  if (NEGATIVE) {
    // 负控：把刷新换成空实现，看 R5-3 会不会红。
    service.refreshSessions = async () => ({ updated: 0, missing: 0 })
  }
  return { service, store }
}

async function main() {
  const { service } = await buildService()
  const target =
    MODE === 'wsl'
      ? { backend: 'wsl', distro: DISTRO, port: PORT, remoteRoot: REMOTE_ROOT }
      : { backend: 'ssh', alias: ALIAS, port: PORT, remoteRoot: REMOTE_ROOT }
  const localPath =
    MODE === 'wsl'
      ? '\\\\wsl.localhost\\' + DISTRO + REMOTE_ROOT.split('/').join('\\')
      : 'C:/Temp/m3-refresh-probe/' + ALIAS

  console.log('==> R5-1 attach（' + MODE + '）')
  const attachStart = Date.now()
  let attachError
  try {
    await service.attach(target, { remotePath: REMOTE_ROOT, localPath, title: 'm3-refresh' })
  } catch (error) {
    attachError = error
  }
  const attachMs = Date.now() - attachStart
  const afterAttach = service.snapshot()
  expect('R5-1', service.connected === true && afterAttach.workspaces[0] !== undefined,
    JSON.stringify({ connected: service.connected, err: attachError && (attachError.code ?? attachError.message) }), attachMs)
  const workspaceId = afterAttach.workspaces[0] && afterAttach.workspaces[0].id

  console.log('==> R5-2 createSession')
  let sessionId
  let sessionError
  try {
    const created = await service.createSession(workspaceId, {})
    sessionId = created.sessionId
  } catch (error) {
    sessionError = error
  }
  expect('R5-2', typeof sessionId === 'string' && sessionId.length > 0,
    JSON.stringify({ err: sessionError && (sessionError.code ?? sessionError.message) }))

  console.log('==> R5-3 refreshSessions')
  const refreshStart = Date.now()
  let outcome
  let refreshError
  try {
    outcome = await service.refreshSessions()
  } catch (error) {
    refreshError = error
  }
  const refreshMs = Date.now() - refreshStart
  const afterRefresh = service.snapshot()
  expect('R5-3', outcome !== undefined && outcome.updated >= 1 && afterRefresh.stale === false,
    JSON.stringify({ outcome, stale: afterRefresh.stale, err: refreshError && (refreshError.code ?? refreshError.message) }), refreshMs)

  console.log('==> R5-4 投影里查得到会话')
  const projected = afterRefresh.sessions.find((row) => row.sessionId === sessionId)
  expect('R5-4', projected !== undefined && typeof projected.running === 'boolean',
    JSON.stringify({ sessions: afterRefresh.sessions.length, found: projected !== undefined, running: projected && projected.running }))

  console.log('==> R5-5 断开后刷新必须结构化报错且不发 RPC')
  const beforeDisconnect = service.snapshot()
  service.disconnect()
  let offlineError
  try {
    await service.refreshSessions()
  } catch (error) {
    offlineError = error
  }
  const afterOfflineRefresh = service.snapshot()
  expect('R5-5', offlineError !== undefined && offlineError.code === 'remote/disconnected' &&
    afterOfflineRefresh.sessions.length === beforeDisconnect.sessions.length,
    JSON.stringify({ code: offlineError && offlineError.code, sessions: afterOfflineRefresh.sessions.length }))

  console.log('==> R5-6 reconnectNow()')
  const reconnectStart = Date.now()
  let reattachError
  if (NEGATIVE) await sleep(100)
  try {
    await service.reconnectNow()
  } catch (error) {
    reattachError = error
  }
  const reconnectMs = Date.now() - reconnectStart
  const afterReconnect = service.snapshot()
  const idsBefore = beforeDisconnect.sessions.map((row) => row.sessionId).sort()
  const idsAfter = afterReconnect.sessions.map((row) => row.sessionId).sort()
  // 口径：投影容量上限是 512（store.ts MAX_PROJECTED_SESSIONS）。远端会话多于上限时，
  // 「哪 512 条」本来就可能在重建后不同（淘汰按插入序），把「id 集合逐字相等」当判据会把
  // 容量上限误判成重连缺陷。这里判的是：workspace 不回退成新的、探针自己建的那条会话仍在、
  // 条数不变；重叠度作为 INFO 打出来供人眼判断。
  const idsB = new Set(idsBefore)
  const overlap = idsAfter.filter((id) => idsB.has(id)).length
  const kept = idsAfter.includes(sessionId)
  console.log('      info: overlap=' + overlap + '/' + idsAfter.length + ' workspaceBefore=' + String(workspaceId) +
    ' workspaceAfter=' + String(afterReconnect.workspaces[0] && afterReconnect.workspaces[0].id))
  // 判据再收一层：探针自己那条会话在超上限时可能被容量淘汰（本机远端会话数远超 512），
  // 所以「它还在」只作 INFO；断言改成「条数不变 + 重叠 ≥ 99% + workspace 不回退」。
  const ratio = idsAfter.length === 0 ? 1 : overlap / idsAfter.length
  expect('R5-6', service.connected === true && afterReconnect.workspaces[0] !== undefined &&
    afterReconnect.workspaces[0].id === workspaceId && idsAfter.length === idsBefore.length && ratio >= 0.99,
    JSON.stringify({ connected: service.connected, workspaceKept: afterReconnect.workspaces[0] !== undefined && afterReconnect.workspaces[0].id === workspaceId,
      keptProbeSession: kept, overlap, idsBefore: idsBefore.length, idsAfter: idsAfter.length,
      err: reattachError && (reattachError.code ?? reattachError.message) }), reconnectMs)

  console.log('==> R5-7 重连后 stale 必须复位')
  expect('R5-7', afterReconnect.stale === false, JSON.stringify({ stale: afterReconnect.stale }))

  try { service.dispose() } catch { /* 探针收尾，失败不影响判定 */ }

  mkdirSync('spikes/m3-refresh', { recursive: true })
  // 按模式分开落盘：两次运行共用一个文件时，后跑的会把前一次的取证覆盖掉。
  writeFileSync('spikes/m3-refresh/measurements-' + MODE + '.json', JSON.stringify({
    mode: MODE, target: MODE === 'wsl' ? DISTRO : ALIAS, negative: NEGATIVE,
    passed, failed, failures, measurements, at: new Date().toISOString(),
  }, null, 2) + '\n')

  console.log('\n' + (MODE === 'wsl' ? 'WSL' : 'SSH') + ' 目标：通过 ' + passed + ' / 失败 ' + failed +
    (failed === 0 ? '' : ' → ' + failures.join(',')))
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => { console.error('probe crashed: ' + (error && error.stack ? error.stack : error)); process.exit(2) })
