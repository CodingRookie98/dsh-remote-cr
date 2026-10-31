#!/usr/bin/env node
/**
 * P3.2 真机探针：用**产品代码**（src/local/backend/wsl/launch.ts）起一个远端 dsh，
 * 证明它真的能用、真的能被收干净、真的会在失败时给出可操作的结构化错误。
 *
 * 零第三方依赖。区别于 cross-machine-t5/t6：那两个证明的是**官方内核接缝**，
 * 这一个证明的是**我们自己的启动与回收实现**。
 *
 * 断言：
 *   P32-1  launchRemoteDsh 等到 URL，token 非空，端口正确
 *   P32-2  该端点真的可连：GET /?token= → 303 + cookie；带 cookie GET / → 200
 *   P32-3  RPC 打 directoryPicker/list 拿到**远端真实** home（不是本机）
 *   P32-4  dispose() 之后端口不再监听（句柄即生命周期，不需要 wsl --terminate）
 *   P32-5  远端端口被占用 → remote/port-in-use，nextActions 三条且含 port+1
 *   P32-6  远端无 node → remote/node-missing（不是笼统 startup-failed）
 *   P32-7  取消（AbortSignal）→ remote/cancelled，且端口被收掉
 *
 * 负控（NEGATIVE_CONTROL=1）：**变异被测量而不是反转断言** ——
 * 用错 token 做握手、用错 cookie 打 RPC、跳过 dispose，三条对应的断言必须变红。
 * 末尾校验失败集恰为 {P32-2, P32-3, P32-4}，多一条少一条都算失败。
 */

const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const NEG = process.env.NEGATIVE_CONTROL === '1'
const DISTRO = process.env.DSH_DISTRO ?? 'ubuntu_dev'
const REMOTE_ROOT = process.env.DSH_REMOTE_ROOT ?? '/home/hui/workspace/tools/deepseek-harness'
const BASE_PORT = Number.parseInt(process.env.DSH_PORT ?? '8901', 10)

let passed = 0
let failed = 0
const failures = []

/** 断言。负控通过**变异被测量**（见 main 里的 `NEG ? … : …`）而不是反转这里。 */
function expect(name, condition, detail) {
  const verdict = condition
  if (verdict) {
    passed += 1
    console.log('  PASS ' + name + (detail === undefined ? '' : ' ' + detail))
  } else {
    failed += 1
    failures.push(name)
    console.log('  FAIL ' + name + (detail === undefined ? '' : ' ' + detail))
  }
}

function isPortFree(port) {
  const result = spawnSync('wsl.exe', ['-d', DISTRO, '--exec', 'ss', '-ltn'], { windowsHide: true })
  const text = Buffer.from(result.stdout ?? []).toString('utf8')
  return !text.includes(':' + String(port) + ' ')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function httpGet(url, options) {
  return fetch(url, { redirect: 'manual', ...(options ?? {}) })
}

/** 在 distro 内起一个占端口的进程（用 node 自带的 net，不依赖 python）。 */
function squatRemotePort(port) {
  const script = [
    'const net=require("node:net")',
    'const port=Number(process.argv[1])',
    'const server=net.createServer(function(){})',
    'server.listen(port,"127.0.0.1",function(){console.log("SQUAT_READY")})',
    'setTimeout(function(){server.close();process.exit(0)},120000)',
  ].join(';')
  const inner = 'setsid nohup node -e ' + "'" + script + "'" + ' ' + String(port) + ' > /tmp/p32-squat.log 2>&1 < /dev/null & sleep 1.5; cat /tmp/p32-squat.log'
  const result = spawnSync('wsl.exe', ['-d', DISTRO, '--exec', 'bash', '-lc', inner], { windowsHide: true })
  return Buffer.from(result.stdout ?? []).toString('utf8')
}

/**
 * 收尾：按「cmdline 含 needle」+「exe 指向 node」双条件杀，避免误杀非 node 进程。
 *
 * **教训（真机踩到）**：不能按 `/proc/<pid>/comm == node` 筛。`node -e ...` 启动的进程
 * 其 comm 是 `MainThread`（V8 改了主线程名），按 comm 筛会漏掉它，占端口的进程就留下来了，
 * 下一轮断言于是变成假通过。判据要落在 `readlink /proc/<pid>/exe` 或 cmdline 上。
 */
function killRemoteByPattern(needle) {
  const inner =
    'for p in /proc/[0-9]*; do ' +
    'case "$(readlink $p/exe 2>/dev/null)" in */node|*/nodejs) ' +
    'if tr "\\0" " " < $p/cmdline 2>/dev/null | grep -q ' + "'" + needle + "'" + '; then kill $(basename $p) 2>/dev/null; fi;; ' +
    'esac; done; echo CLEANED'
  const result = spawnSync('wsl.exe', ['-d', DISTRO, '--exec', 'bash', '-lc', inner], { windowsHide: true })
  return Buffer.from(result.stdout ?? []).toString('utf8').trim()
}

async function main() {
  const launchMod = await import(
    pathToFileURL(path.join(__dirname, '../../../src/local/backend/wsl/launch.ts')).href
  )

  console.log('==> P32-1 启动远端 dsh（产品代码路径）')
  const port = BASE_PORT
  const handle = await launchMod.launchRemoteDsh({
    distro: DISTRO,
    remoteRoot: REMOTE_ROOT,
    port,
    timeoutMs: 90000,
  })
  const endpoint = handle.endpoint
  expect(
    'P32-1',
    endpoint.token.length > 20 && endpoint.port === port,
    JSON.stringify({ host: endpoint.host, port: endpoint.port, tokenLen: endpoint.token.length }),
  )

  const base = 'http://' + endpoint.host + ':' + String(endpoint.port)

  console.log('==> P32-2 端点可连（认证握手）')
  // 负控：故意用错 token —— 若断言是空的，这里照样会绿。
  const handshakeToken = NEG ? 'wrong-token-teleport-negative-control' : endpoint.token
  const handshake = await httpGet(base + '/?token=' + encodeURIComponent(handshakeToken))
  const setCookie = handshake.headers.get('set-cookie') ?? ''
  const cookie = setCookie.split(';')[0]
  // 负控：cookie 本身是对的，但下面用它打 RPC 时会被换掉（保 P32-2 只受 token 影响）。
  const page = cookie === '' ? undefined : await httpGet(base + '/', { headers: { cookie } })
  expect(
    'P32-2',
    handshake.status === 303 && cookie !== '' && page !== undefined && page.status === 200,
    JSON.stringify({ handshake: handshake.status, cookie: cookie === '' ? 'MISSING' : 'ok', page: page && page.status }),
  )

  console.log('==> P32-3 远端事实从远端返回')
  const rpcCookie = NEG ? 'dsh-auth-negative-control=v2.bogus.bogus' : cookie
  const rpc = await fetch(base + '/api/directoryPicker/list', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(rpcCookie === '' ? {} : { cookie: rpcCookie }) },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'p32',
      method: 'directoryPicker/list',
      payload: { args: {} },
    }),
  })
  // 负控下这里会拿到 401 + 纯文本 "unauthorized"，不能让它把探针崩掉——
  // 解析失败本身就是「这条断言该红」的证据，不是程序错误。
  let body
  try {
    body = await rpc.json()
  } catch {
    body = undefined
  }
  const remoteHome = body && body.result && body.result.ok ? body.result.value && body.result.value.home : undefined
  const localHome = os.homedir()
  expect(
    'P32-3',
    typeof remoteHome === 'string' && remoteHome !== localHome && remoteHome.startsWith('/'),
    JSON.stringify({ remoteHome, localHome, differs: remoteHome !== localHome }),
  )

  console.log('==> P32-4 dispose 收干净（句柄即生命周期）')
  // 负控：不 dispose，然后**如实**去问端口还开着吗。
  // 关键：这里不能把 free 的计算也反过来 —— 那样变异会自我抵消，断言就变成空的了。
  const clean = NEG ? true : await handle.dispose()
  await sleep(300)
  const free = isPortFree(port)
  expect('P32-4', clean === true && free === true, JSON.stringify({ clean, portFree: free }))

  console.log('==> P32-5 远端端口被占用 → remote/port-in-use')
  const squatPort = port + 2
  // 上一轮可能留下占端口的进程：先收干净，否则「占端口」本身会失败，断言就变成假通过。
  killRemoteByPattern('SQUAT_READY')
  await sleep(300)
  const squatLog = squatRemotePort(squatPort)
  const squatListening = !isPortFree(squatPort)
  let portInUseError
  try {
    const holder = await launchMod.launchRemoteDsh({
      distro: DISTRO,
      remoteRoot: REMOTE_ROOT,
      port: squatPort,
      timeoutMs: 60000,
    })
    await holder.dispose()
  } catch (error) {
    portInUseError = error
  }
  expect(
    'P32-5',
    squatListening &&
      portInUseError !== undefined &&
      portInUseError.code === 'remote/port-in-use' &&
      portInUseError.nextActions.length === 3 &&
      String(portInUseError.nextActions[1]).includes(String(squatPort + 1)),
    JSON.stringify({
      squatListening,
      squatLogTail: squatLog.trim().slice(0, 120),
      code: portInUseError && portInUseError.code,
      actions: portInUseError && portInUseError.nextActions,
    }),
  )

  console.log('==> P32-6 远端无 node → remote/node-missing')
  let noNodeError
  try {
    const holder = await launchMod.launchRemoteDsh({
      distro: DISTRO,
      remoteRoot: REMOTE_ROOT,
      port: port + 3,
      nodeCommand: 'node-missing-teleport',
      timeoutMs: 20000,
    })
    await holder.dispose()
  } catch (error) {
    noNodeError = error
  }
  expect(
    'P32-6',
    noNodeError !== undefined &&
      noNodeError.code === 'remote/node-missing' &&
      /node-missing-teleport/.test(noNodeError.detail),
    JSON.stringify({ code: noNodeError && noNodeError.code, detail: noNodeError && noNodeError.detail }),
  )

  console.log('==> P32-7 取消 → remote/cancelled 且端口被收掉')
  const abortPort = port + 4
  const controller = new AbortController()
  const cancelled = launchMod.launchRemoteDsh({
    distro: DISTRO,
    remoteRoot: REMOTE_ROOT,
    port: abortPort,
    timeoutMs: 90000,
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(), 1500)
  let cancelError
  try {
    const holder = await cancelled
    await holder.dispose()
  } catch (error) {
    cancelError = error
  }
  await sleep(800)
  const abortFree = isPortFree(abortPort)
  expect(
    'P32-7',
    cancelError !== undefined && cancelError.code === 'remote/cancelled' && abortFree,
    JSON.stringify({ code: cancelError && cancelError.code, portFree: abortFree }),
  )

  console.log('      cleanup dsh: ' + killRemoteByPattern('bin.js web'))
  console.log('      cleanup squat: ' + killRemoteByPattern('SQUAT_READY'))

  // 负控的判据不是「失败了就算对」，而是**失败集必须恰好等于变异点**：
  // 少一条说明那条断言是空的（变异了还绿），多一条说明有断言被别的因素带红了。
  const expected = ['P32-2', 'P32-3', 'P32-4']
  const sorted = [...failures].sort()
  const matches = NEG
    ? sorted.length === expected.length && expected.every((name, index) => name === sorted[index])
    : true
  if (NEG) {
    console.log('')
    console.log('  ' + (matches ? 'PASS' : 'FAIL') + ' NEGATIVE_CONTROL 失败集=' + JSON.stringify(sorted) + ' 期望=' + JSON.stringify(expected))
  }

  console.log('')
  console.log('--- ' + String(passed) + '/' + String(passed + failed) + ' passed, ' + String(failed) + ' failed ---')
  if (failures.length > 0) console.log('failed: ' + failures.join(', '))
  const code = NEG ? (matches ? 0 : 1) : failed === 0 ? 0 : 1
  process.exit(code)
}

main().catch((error) => {
  console.error('FATAL ' + (error && error.stack ? error.stack : String(error)))
  process.exit(2)
})