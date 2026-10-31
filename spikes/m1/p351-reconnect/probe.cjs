#!/usr/bin/env node
/**
 * P3.5.1 真机探针：断线 → 自动重连 → 投影重建 → 手动重连 → 收干净。
 *
 * 与 p35-projection 的分工：p35 证明「连得上、能投影、命令真在远端跑」；这一个证明
 * requirements.md A7 ——「网络中断/远端重启后，工作区状态可见、可一键重连，远端进程
 * 可回收（不留孤儿）」，以及 A8 的「不出现远端未可用却本地执行」。
 *
 * 断言：
 *   P351-1  基线：attach 成功，link=connected，投影表里有 1 个工作区且 online
 *   P351-2  杀远端进程后再发 RPC：错误码必须是 remote/tunnel-unavailable（不是 remote/unknown），
 *           并且服务立刻转成 link=retrying、connected=false、投影全部 offline（可见但不可用）
 *   P351-3  自动重连真的把它连回来了（2s/4s/8s 的第一档）：link 回到 connected，端口重新监听
 *   P351-4  重连成功后投影表按远端**重建**：仍恰好 1 个工作区、online、会话都 online
 *   P351-5  手动重连：disconnect() 后 link=idle（且不再自动重试），reconnectNow() 当场连回
 *   P351-6  dispose 之后端口不再监听、distro 内没有残留的 dsh web 进程（不留孤儿）
 *
 * 负控（NEGATIVE_CONTROL=1）：**变异被测量而不是反转断言** —— 注入一个「永不触发」的
 * 重连定时器（ProjectionServiceOptions.timers 是产品代码留的接缝）。这样传输层失败
 * 仍然被识别（P351-2 照绿），但自动重连永远不执行，于是失败集必须恰好是
 * {P351-3, P351-4}：P351-3 是变异点直接打中的那条，P351-4 是级联（没连回来就没有重建）。
 * P351-5 手动重连走的是 await 一条独立路径、不经过定时器，所以照绿——这正是我们要区分的
 * 「自动重连坏了」和「重连能力坏了」。
 *
 * 复跑：node spikes/m1/p351-reconnect/probe.cjs
 * 可假性：NEGATIVE_CONTROL=1 node .../probe.cjs 必须整体失败（退出码 1）——注意负控下
 * 失败集精确匹配才算 PASS，此时进程退出码是 0（与 p35 一致的约定）。
 */

const net = require('node:net')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const NEG = process.env.NEGATIVE_CONTROL === '1'
const DISTRO = process.env.DSH_DISTRO ?? 'ubuntu_dev'
const REMOTE_ROOT = process.env.DSH_REMOTE_ROOT ?? '/home/hui/workspace/tools/deepseek-harness'
const PORT = Number.parseInt(process.env.DSH_PORT ?? '8905', 10)
const REMOTE_PATH = process.env.DSH_PROJECT_PATH ?? REMOTE_ROOT
/** 等自动重连的上限：一档 2s + 远端冷启动 12–18s，留足余量。 */
const WAIT_MS = NEG ? 8000 : 120_000

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

function note(text) {
  console.log('       ' + text)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 端口是否已被释放：只看 distro 里的监听表，不问 Windows 侧（WSL2 是 NAT）。 */
function isPortFree(port) {
  const result = spawnSync('wsl.exe', ['-d', DISTRO, '--exec', 'ss', '-ltn'], { windowsHide: true })
  const text = Buffer.from(result.stdout ?? []).toString('utf8')
  return !text.includes(':' + String(port) + ' ')
}

/**
 * 数 distro 内还活着的 dsh web 进程。
 *
 * 双条件（p32/p35 真机踩到的坑）：Node 24 的 /proc/<pid>/comm 是 MainThread，
 * 不能按 comm 筛；/proc/<pid>/cmdline 是 NUL 分隔，要先 tr 成空格再子串匹配。
 */
function countRemoteDsh() {
  const inner =
    'n=0; for p in /proc/[0-9]*; do ' +
    'case "$(readlink $p/exe 2>/dev/null)" in */node|*/nodejs) ' +
    'if tr "\\0" " " < $p/cmdline 2>/dev/null | grep -q "bin.js web"; then n=$((n+1)); fi;; ' +
    'esac; done; echo $n'
  const result = spawnSync('wsl.exe', ['-d', DISTRO, '--exec', 'bash', '-lc', inner], { windowsHide: true })
  const text = Buffer.from(result.stdout ?? '').toString('utf8').trim()
  const parsed = Number.parseInt(text, 10)
  return Number.isFinite(parsed) ? parsed : -1
}

async function killRemote() {
  const inner =
    'for p in /proc/[0-9]*; do ' +
    'case "$(readlink $p/exe 2>/dev/null)" in */node|*/nodejs) ' +
    'if tr "\\0" " " < $p/cmdline 2>/dev/null | grep -q "bin.js web"; then kill -9 $(basename $p) 2>/dev/null; fi;; ' +
    'esac; done; echo CLEANED'
  spawnSync('wsl.exe', ['-d', DISTRO, '--exec', 'bash', '-lc', inner], { windowsHide: true })
  // 等端口真的不再监听：kill -9 之后内核回收监听 socket 有几毫秒延迟。
  for (let i = 0; i < 40; i += 1) {
    if (isPortFree(PORT)) return true
    await sleep(250)
  }
  return false
}

/** 永不触发的定时器：负控用它把「自动重连」这条链路精确切掉。 */
function deadTimers() {
  const pending = new Set()
  return {
    schedule(_delayMs, _run) {
      const handle = setTimeout(() => {}, 0)
      pending.add(handle)
      return {
        cancel() {
          clearTimeout(handle)
          pending.delete(handle)
        },
      }
    },
    cancel(handle) {
      handle.cancel()
    },
  }
}

async function main() {
  const root = path.join(__dirname, '../../..')
  const load = (relative) => import(pathToFileURL(path.join(root, relative)).href)
  const liveMod = await load('src/local/projection/live.ts')
  const serviceMod = await load('src/local/projection/service.ts')
  const storeMod = await load('src/local/projection/store.ts')

  const target = { distro: DISTRO, port: PORT, remoteRoot: REMOTE_ROOT }
  const localPath = '\\\\wsl.localhost\\' + DISTRO + REMOTE_PATH.split('/').join('\\')
  const store = new storeMod.ProjectionStore()
  const service = new serviceMod.ProjectionService({
    store,
    connect: liveMod.createLiveConnect({ launchTimeoutMs: 90000 }),
    ...(NEG ? { timers: deadTimers() } : {}),
  })

  // 上一轮可能留下占端口的 dsh：先收干净，否则「启动」这一步会撞端口。
  note('cleanup before: ' + JSON.stringify({ killed: await killRemote(), portFree: isPortFree(PORT) }))

  console.log('==> P351-1 基线：attach 成功且投影 1 个工作区 online')
  let attachError
  try {
    await service.attach(target, { remotePath: REMOTE_PATH, localPath, title: 'p351' })
  } catch (error) {
    attachError = error
  }
  let snapshot = service.snapshot()
  expect(
    'P351-1',
    attachError === undefined &&
      snapshot.connected === true &&
      snapshot.link === 'connected' &&
      snapshot.workspaces.length === 1 &&
      snapshot.workspaces[0].availability === 'online',
    JSON.stringify({
      error: attachError && (attachError.code ?? attachError.message),
      connected: snapshot.connected,
      link: snapshot.link,
      workspaces: snapshot.workspaces.length,
    }),
  )
  const baselineWorkspaceId = snapshot.workspaces.length === 1 ? snapshot.workspaces[0].id : undefined
  note('baseline workspaceId: ' + String(baselineWorkspaceId) + ' / sessions: ' + String(snapshot.sessions.length))

  console.log('==> P351-2 杀远端进程，再发一次 RPC：必须是 tunnel-unavailable + retrying + 投影 offline')
  const killed = await killRemote()
  note('killed=' + String(killed) + ' portFree=' + String(isPortFree(PORT)))
  let lossError
  try {
    // 复用同一个 target：不会重新握手，直接打到已经死掉的远端上。
    await service.attach(target, { remotePath: REMOTE_PATH, localPath, title: 'p351' })
  } catch (error) {
    lossError = error
  }
  snapshot = service.snapshot()
  expect(
    'P351-2',
    killed === true &&
      lossError !== undefined &&
      lossError.code === 'remote/tunnel-unavailable' &&
      snapshot.connected === false &&
      snapshot.link === 'retrying' &&
      snapshot.workspaces.length === 1 &&
      snapshot.workspaces.every((workspace) => workspace.availability === 'offline'),
    JSON.stringify({
      killed,
      code: lossError && lossError.code,
      connected: snapshot.connected,
      link: snapshot.link,
      availability: snapshot.workspaces.map((workspace) => workspace.availability),
    }),
  )

  console.log('==> P351-3 自动重连把它连回来（第一档 2s，加远端冷启动）')
  const reconnectStarted = Date.now()
  let backOnline = false
  while (Date.now() - reconnectStarted < WAIT_MS) {
    if (service.snapshot().link === 'connected') {
      backOnline = true
      break
    }
    await sleep(500)
  }
  const reconnectMs = Date.now() - reconnectStarted
  expect(
    'P351-3',
    backOnline === true && isPortFree(PORT) === false,
    JSON.stringify({ link: service.snapshot().link, ms: reconnectMs, portListening: isPortFree(PORT) === false }),
  )

  console.log('==> P351-4 重连后投影表按远端重建：1 个工作区 online、会话都 online')
  snapshot = service.snapshot()
  let reattach
  if (backOnline) {
    try {
      reattach = await service.attach(target, { remotePath: REMOTE_PATH, localPath, title: 'p351' })
    } catch (error) {
      note('re-attach 失败：' + String(error && (error.code ?? error.message)))
    }
  }
  snapshot = service.snapshot()
  expect(
    'P351-4',
    snapshot.connected === true &&
      snapshot.link === 'connected' &&
      snapshot.workspaces.length === 1 &&
      snapshot.workspaces[0].availability === 'online' &&
      snapshot.sessions.every((session) => session.availability === 'online'),
    JSON.stringify({
      connected: snapshot.connected,
      link: snapshot.link,
      workspaces: snapshot.workspaces.length,
      ids: snapshot.workspaces.map((workspace) => workspace.id),
      sessions: snapshot.sessions.length,
      online: snapshot.sessions.every((session) => session.availability === 'online'),
    }),
  )
  note(
    'id 保持=' +
      String(reattach !== undefined && reattach.workspace.id === baselineWorkspaceId) +
      ' / created=' +
      String(reattach === undefined ? 'n/a' : reattach.created) +
      ' / sessions=' +
      String(snapshot.sessions.length),
  )

  console.log('==> P351-5 手动重连：disconnect 后 idle 且不再自动重试，reconnectNow 当场连回')
  service.disconnect()
  const afterDisconnect = service.snapshot()
  // 手动断连不该再自己去连：等一会儿，link 必须还停在 idle。
  await sleep(1500)
  const stillIdle = service.snapshot().link === 'idle'
  let manualError
  try {
    await service.reconnectNow()
  } catch (error) {
    manualError = error
  }
  const afterManual = service.snapshot()
  expect(
    'P351-5',
    afterDisconnect.link === 'idle' &&
      afterDisconnect.connected === false &&
      stillIdle === true &&
      manualError === undefined &&
      afterManual.link === 'connected' &&
      afterManual.connected === true,
    JSON.stringify({
      afterDisconnect: afterDisconnect.link,
      stillIdle,
      error: manualError && (manualError.code ?? manualError.message),
      afterManual: afterManual.link,
    }),
  )

  console.log('==> P351-6 dispose 收干净：端口释放、distro 内无残留 dsh web')
  service.dispose()
  await sleep(1500)
  const freePort = isPortFree(PORT)
  const leftover = countRemoteDsh()
  expect('P351-6', freePort === true && leftover === 0, JSON.stringify({ portFree: freePort, leftover }))

  // 负控判据：失败集必须**恰好**等于变异点。
  const expected = ['P351-3', 'P351-4']
  const sorted = [...failures].sort()
  const matches = NEG ? sorted.length === expected.length && expected.every((name, index) => name === sorted[index]) : true
  if (NEG) {
    console.log('')
    console.log(
      '  ' +
        (matches ? 'PASS' : 'FAIL') +
        ' NEGATIVE_CONTROL 失败集=' +
        JSON.stringify(sorted) +
        ' 期望=' +
        JSON.stringify(expected),
    )
  }

  console.log('')
  console.log('--- ' + String(passed) + '/' + String(passed + failed) + ' passed, ' + String(failed) + ' failed ---')
  if (failures.length > 0) console.log('failed: ' + failures.join(', '))
  process.exit(NEG ? (matches ? 0 : 1) : failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('FATAL ' + (error && error.stack ? error.stack : String(error)))
  process.exit(2)
})
