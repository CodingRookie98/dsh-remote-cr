#!/usr/bin/env node
/**
 * T1 探针（RFC-0003）：WSL 后端下「断开 → reconnectNow()」是否等价可用。
 *
 * 决定 RFC 的 D3 默认值：如果 WSL 也能原地重连成功，面板的「重新连接」对两种后端都开；
 * 否则 WSL 只显示「在面板中重连」。
 *
 * 断言：
 *   T1-1 attach 成功，投影 connected 且工作区 online
 *   T1-2 disconnect() 后 connected=false、工作区全部标 offline（这是灰显的数据前提）
 *   T1-3 reconnectNow() 成功回到 connected，且工作区 id 与断开前一致
 *   T1-4 重连后对**已存在会话**做一次 probe（命令真的在远端跑），证明不是只翻了个标志位
 *   T1-5 dispose 后 connected=false
 */
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const DISTRO = process.env.DSH_DISTRO ?? 'ubuntu_dev'
const REMOTE_ROOT = process.env.DSH_REMOTE_ROOT ?? '/home/hui/workspace/tools/deepseek-harness'
const PORT = Number.parseInt(process.env.DSH_PORT ?? '8903', 10)

let passed = 0
let failed = 0
const failures = []

function expect(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log('  PASS ' + name + (detail === undefined ? '' : ' ' + detail))
  } else {
    failed += 1
    failures.push(name)
    console.log('  FAIL ' + name + (detail === undefined ? '' : ' ' + detail))
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function load(rel) {
  return import(pathToFileURL(path.join(process.cwd(), rel)).href)
}

/** 收掉上一轮可能残留的远端 dsh（按 cmdline + node 双条件）。 */
function killRemoteByPattern(needle) {
  const inner =
    'for p in /proc/[0-9]*; do ' +
    'case "$(readlink $p/exe 2>/dev/null)" in *node*) ;; *) continue;; esac; ' +
    'tr "\\0" " " < $p/cmdline 2>/dev/null | grep -q -- "' + needle + '" && kill -9 ${p#/proc/}; ' +
    'done; echo cleaned'
  const result = spawnSync('wsl.exe', ['-d', DISTRO, '--exec', 'sh', '-c', inner], { windowsHide: true })
  return Buffer.from(result.stdout ?? []).toString('utf8').trim()
}

async function main() {
  const liveMod = await load('src/local/projection/live.ts')
  const serviceMod = await load('src/local/projection/service.ts')
  const storeMod = await load('src/local/projection/store.ts')
  const probeMod = await load('src/local/projection/probe.ts')

  const target = { distro: DISTRO, port: PORT, remoteRoot: REMOTE_ROOT }
  const store = new storeMod.ProjectionStore()
  const service = new serviceMod.ProjectionService({
    store,
    connect: liveMod.createLiveConnect({ launchTimeoutMs: 90000 }),
  })

  console.log('      cleanup before: ' + killRemoteByPattern('bin.js web'))
  await sleep(300)

  const remotePath = REMOTE_ROOT
  const localPath = '\\\\wsl.localhost\\' + DISTRO + remotePath.split('/').join('\\')

  console.log('==> T1-1 attach（WSL）')
  let attach
  let attachError
  try {
    attach = await service.attach(target, { remotePath, localPath, title: 't1-reconnect' })
  } catch (error) {
    attachError = error
  }
  expect(
    'T1-1',
    service.connected === true && attach !== undefined,
    JSON.stringify({ error: attachError && (attachError.code ?? attachError.message), connected: service.connected }),
  )
  const before = service.snapshot()
  const workspaceId = before.workspaces[0] === undefined ? undefined : before.workspaces[0].id

  // 会话必须先建出来：重连后要拿它证明「命令真的还能在远端跑」。
  // 首跑漏了这一步，T1-4 因为没会话直接判失败（空 detail）——是探针的缺陷，不是产品问题。
  let sessionId
  let createError
  if (workspaceId !== undefined) {
    try {
      const created = await service.createSession(workspaceId, {})
      sessionId = created.sessionId
    } catch (error) {
      createError = error
    }
  }
  console.log('      session: ' + String(sessionId) + (createError === undefined ? '' : ' error=' + (createError.code ?? createError.message)))

  console.log('==> T1-2 disconnect（只断传输，标 offline）')
  service.disconnect()
  const offline = service.snapshot()
  expect(
    'T1-2',
    offline.connected === false &&
      offline.workspaces.length === before.workspaces.length &&
      offline.workspaces.every((workspace) => workspace.availability === 'offline'),
    JSON.stringify({
      connected: offline.connected,
      workspaces: offline.workspaces.map((workspace) => workspace.availability),
    }),
  )

  console.log('==> T1-3 reconnectNow()')
  const started = Date.now()
  let reconnectError
  try {
    await service.reconnectNow()
  } catch (error) {
    reconnectError = error
  }
  const ms = Date.now() - started
  const after = service.snapshot()
  expect(
    'T1-3',
    after.connected === true && after.workspaces[0] !== undefined && after.workspaces[0].id === workspaceId,
    JSON.stringify({
      error: reconnectError && (reconnectError.code ?? reconnectError.message),
      connected: after.connected,
      sameWorkspace: after.workspaces[0] !== undefined && after.workspaces[0].id === workspaceId,
      ms,
    }),
  )

  console.log('==> T1-4 重连后对已有会话做一次 probe（命令真的在远端）')
  let probe
  let probeError
  if (sessionId !== undefined) {
    try {
      probe = await service.probe(sessionId)
    } catch (error) {
      probeError = error
    }
  }
  expect(
    'T1-4',
    probe !== undefined && /Linux/i.test(probe.uname ?? '') && String(probe.cwd ?? '').startsWith('/'),
    JSON.stringify({ error: probeError && (probeError.code ?? probeError.message), cwd: probe && probe.cwd, uname: probe && probe.uname && probe.uname.slice(0, 50) }),
  )

  console.log('==> T1-5 dispose')
  await service.dispose()
  expect('T1-5', service.connected === false, JSON.stringify({ connected: service.connected }))

  console.log('')
  console.log('--- ' + passed + '/' + (passed + failed) + ' passed, ' + failed + ' failed ---')
  if (failed > 0) {
    console.log('failed=' + JSON.stringify(failures))
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('探针异常：' + (error && error.stack ? error.stack : String(error)))
  process.exitCode = 1
})
