#!/usr/bin/env node
/**
 * P3.6 真机探针：凭据代理 + 同步屏障（用**产品代码**，不另写一套）。
 *
 * 证明四件事，全部要求「远端真的发生了」：
 *   1. 远端磁盘上只有**占位令牌**，真值从不落到远端（P36-2）；
 *   2. 屏障未过就不发布 online，过了才发布（P36-3），单飞且每次连接重过（P36-4）；
 *   3. 远端发起的**真实请求**经 ③ stdio 桥（产品 `StdioBridge`）打到本机代理，
 *      本机留下该 host 的入站记录 + 替换记录，上游收到的是真值（P36-5，A6 取证口径）；
 *   4. 远端若拿着真钥匙发请求 → 403 挡下、不转发（P36-6）；
 *   5. 代理只绑回环（P36-7，带正向对照证明这条不是空断言）。
 *
 * 零第三方依赖。真值用的是**合成密钥**（`sk-local-only-*`），全程不读用户真实凭据。
 *
 * 负控（NEGATIVE_CONTROL=1）：**变异被测量而不是反转断言** ——
 *   变异 1：把合成密钥写进远端文件（而不是占位串）→ P36-2 必红
 *   变异 2：让屏障写入报 failed → P36-3 必红
 *   变异 3：把并发 ensure 改成串行 → P36-4 必红
 *   变异 4：远端改用真钥匙发请求 → P36-5 必红（拿不到替换记录）
 *   变异 5：远端改用占位串发请求 → P36-6 必红（不会被 403 挡下）
 *   变异 6：把「只绑回环」的测量点换成对照端口 → P36-7 必红
 * 末尾校验失败集**恰等于**上表，多一条少一条都算失败。
 */

const { execFile, spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const NEG = process.env.NEGATIVE_CONTROL === '1'
const DISTRO = process.env.DSH_DISTRO ?? 'ubuntu_dev'
const HOST_LABEL = 'wsl:' + DISTRO
const SYNTHETIC_SECRET = 'sk-local-only-' + String(Date.now())
const REMOTE_DIR = '/tmp/dsh-teleport-p36'
const REMOTE_FILE = REMOTE_DIR + '/provider.json'
const REMOTE_RELAY = REMOTE_DIR + '/relay.cjs'

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

/** 异步派发（本进程有活监听/活子进程时一律用它，spawnSync 会堵死事件循环）。 */
function wslAsync(args, stdin) {
  return new Promise((resolve) => {
    const child = execFile('wsl.exe', args, { encoding: 'buffer', timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        status: error && typeof error.code === 'number' ? error.code : error ? -1 : 0,
        stdout: Buffer.from(stdout ?? []).toString('utf8').trim(),
        stderr: Buffer.from(stderr ?? []).toString('utf8').trim(),
      })
    })
    if (stdin !== undefined) child.stdin?.end(stdin)
  })
}

function inDistro(script) {
  return wslAsync(['-d', DISTRO, '--exec', 'bash', '-c', script])
}

/** 起一个假上游，把收到的头原样记下来，用于断言「上游到底看到了什么」。 */
function startFakeUpstream() {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url ?? '/', headers: req.headers })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }))
  })
}

/** 从 distro 侧用 curl 发一次请求（异步，绝不阻塞桥）。 */
function remoteCurl(url, headers) {
  const headerArgs = headers.map((h) => "-H '" + h + "'").join(' ')
  return wslAsync(['-d', DISTRO, '--exec', 'bash', '-c', "curl -sS -m 15 -o /dev/null -w '%{http_code}' " + headerArgs + " '" + url + "'"])
}

function nonLoopbackIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return undefined
}

function connectOnce(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

async function main() {
  const here = __dirname
  const load = (relative) => import(pathToFileURL(path.join(here, relative)).href)
  const placeholderMod = await load('../../../src/local/proxy/placeholder.ts')
  const credentialsMod = await load('../../../src/local/proxy/credentials.ts')
  const proxyMod = await load('../../../src/local/proxy/proxy.ts')
  const bridgeMod = await load('../../../src/local/proxy/bridge.ts')
  const barrierMod = await load('../../../src/local/proxy/barrier.ts')

  const upstream = await startFakeUpstream()
  const table = new placeholderMod.PlaceholderTable('p36-probe-salt')
  const ref = 'DEEPSEEK_API_KEY'
  const placeholder = table.register(ref)
  const credentials = new credentialsMod.LocalCredentials({
    env: { [ref]: SYNTHETIC_SECRET },
    refs: new Map(),
  })

  console.log('==> P36-1 占位串确定性（重启后远端已写入的占位串仍要能认出来）')
  const again = new placeholderMod.PlaceholderTable('p36-probe-salt').register(ref)
  const otherSalt = new placeholderMod.PlaceholderTable('other-salt').register(ref)
  expect(
    'P36-1',
    placeholder === again && placeholder !== otherSalt && placeholderMod.looksLikePlaceholder(placeholder),
    JSON.stringify({ same: placeholder === again, differsBySalt: placeholder !== otherSalt, shape: placeholder.slice(0, 16) + '…' }),
  )

  // ---- 本地代理（产品代码，只绑 127.0.0.1）----
  const proxy = new proxyMod.CredentialProxy({
    port: 0,
    table,
    credentials,
    resolveUpstream: (provider) => (provider === 'deepseek' ? 'http://127.0.0.1:' + upstream.port : undefined),
  })
  const proxyPort = await proxy.start()
  console.log('      proxy listening on ' + proxyMod.PROXY_BIND_HOST + ':' + proxyPort)

  // ---- ③ stdio 桥：distro 侧 relay + 宿主侧产品 StdioBridge ----
  const relaySource = fs.readFileSync(path.join(here, '../wsl-closed-loop/relay.cjs'), 'utf8')
  await inDistro('mkdir -p ' + REMOTE_DIR + ' && cat > ' + REMOTE_RELAY + ' <<\'P36_EOF\'\n' + relaySource + '\nP36_EOF')
  const relay = spawn('wsl.exe', ['-d', DISTRO, '--exec', 'node', REMOTE_RELAY], { stdio: ['pipe', 'pipe', 'pipe'] })
  let relayPort
  const relayReady = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 20000)
    const bridge = new bridgeMod.StdioBridge({
      write: (frame) => relay.stdin.write(frame),
      connectProxy: () => net.connect(proxyPort, '127.0.0.1'),
      onReady: (port) => {
        relayPort = port
        clearTimeout(timer)
        resolve(port)
      },
      onStray: (frame) => console.log('      stray frame type=' + frame.type),
    })
    relay.stdout.on('data', (chunk) => bridge.ingest(chunk))
    relay.stderr.on('data', (chunk) => console.log('      relay stderr: ' + Buffer.from(chunk).toString('utf8').trim()))
    globalThis.__p36Bridge = bridge
  })
  relayPort = await relayReady
  console.log('      relay (distro 内) 监听 127.0.0.1:' + String(relayPort))
  if (relayPort === undefined) {
    console.log('FATAL ③ stdio 桥未就绪，后续断言无从取证')
    relay.kill()
    await proxy.stop()
    upstream.server.close()
    process.exit(2)
  }

  // ---- 屏障：把占位串 + 代理端点写进远端 ----
  // 写入内容刻意包含端点（tier ③ 的 distro 内端口），因为远端 patch 需要它。
  const payloadFor = (rawKey) =>
    JSON.stringify({ provider: 'deepseek', baseUrl: 'http://127.0.0.1:' + relayPort, apiKey: rawKey, host: HOST_LABEL }, null, 2) + '\n'
  const writeRemote = async (rawKey) => {
    const written = await inDistro('mkdir -p ' + REMOTE_DIR + ' && cat > ' + REMOTE_FILE + ' <<\'P36_EOF\'\n' + payloadFor(rawKey) + 'P36_EOF')
    if (written.status !== 0) return { outcome: 'failed', detail: 'remote write exited with ' + String(written.status) + ': ' + written.stderr.slice(0, 120) }
    return { outcome: 'applied' }
  }

  console.log('==> P36-2 远端磁盘只有占位令牌')
  const barrierKey = NEG ? SYNTHETIC_SECRET : placeholder
  const applied = await writeRemote(barrierKey)
  const remoteText = (await inDistro('cat ' + REMOTE_FILE)).stdout
  expect(
    'P36-2',
    applied.outcome === 'applied' && remoteText.includes(placeholder) && !remoteText.includes(SYNTHETIC_SECRET),
    JSON.stringify({
      outcome: applied.outcome,
      hasPlaceholder: remoteText.includes(placeholder),
      leaksSecret: remoteText.includes(SYNTHETIC_SECRET),
      head: remoteText.split('\n')[2] ?? '',
    }),
  )

  console.log('==> P36-3 屏障门禁：未过不发布 online，过了才发布')
  // 负控：让「应当成功」的那次写入真的失败 —— 于是「过了才 online」这半边被证伪。
  const okOutcome = NEG ? 'failed' : 'applied'
  let writeCalls = 0
  const gateBarrier = new barrierMod.SyncBarrier({
    write: async () => {
      writeCalls += 1
      return { outcome: okOutcome }
    },
    isPublished: () => false,
  })
  const gate = barrierMod.connectionGate(await gateBarrier.ensure(HOST_LABEL))
  const blockedBarrier = new barrierMod.SyncBarrier({
    write: async () => ({ outcome: 'failed', detail: 'synthetic failure' }),
    isPublished: () => false,
  })
  const blockedGate = barrierMod.connectionGate(await blockedBarrier.ensure(HOST_LABEL))
  expect(
    'P36-3',
    gate.publish === 'online' &&
      blockedGate.publish === 'failed' &&
      blockedGate.retryable === true &&
      blockedGate.code === 'proxy/sync-failed',
    JSON.stringify({ gate: gate.publish, blocked: blockedGate.publish, code: blockedGate.code, retryable: blockedGate.retryable }),
  )

  console.log('==> P36-4 屏障单飞 + 每次连接重过（不缓存结论）')
  let flights = 0
  const flightBarrier = new barrierMod.SyncBarrier({
    write: async () => {
      flights += 1
      await new Promise((resolve) => setTimeout(resolve, 30))
      return { outcome: 'applied' }
    },
    isPublished: () => false,
  })
  if (NEG) {
    // 变异：串行调用 —— 若断言是空的，串行也会绿。
    await flightBarrier.ensure(HOST_LABEL)
    await flightBarrier.ensure(HOST_LABEL)
  } else {
    await Promise.all([flightBarrier.ensure(HOST_LABEL), flightBarrier.ensure(HOST_LABEL), flightBarrier.ensure(HOST_LABEL)])
  }
  const afterConcurrent = flights
  await flightBarrier.ensure(HOST_LABEL)
  expect(
    'P36-4',
    afterConcurrent === 1 && flights === 2 && flightBarrier.inFlight(HOST_LABEL) === false,
    JSON.stringify({ concurrentWrites: afterConcurrent, totalWrites: flights }),
  )

  console.log('==> P36-5 远端真实请求经 ③ 桥到达本机代理，本机完成替换（A6 口径）')
  const url = 'http://127.0.0.1:' + String(relayPort) + '/r/deepseek/chat/completions'
  const e2eToken = NEG ? SYNTHETIC_SECRET : 'Bearer ' + placeholder
  const e2eStatus = await remoteCurl(url, ['authorization: ' + e2eToken, 'x-teleport-host: ' + HOST_LABEL])
  const okRecord = proxy.records().find((record) => record.outcome === 'ok' && record.remote === HOST_LABEL)
  const upstreamAuth = upstream.seen[0]?.headers['authorization']
  expect(
    'P36-5',
    e2eStatus.stdout === '200' &&
      okRecord !== undefined &&
      okRecord.substitutions.length === 1 &&
      okRecord.substitutions[0].ref === ref &&
      okRecord.substitutions[0].header === 'authorization' &&
      upstreamAuth === 'Bearer ' + SYNTHETIC_SECRET &&
      !JSON.stringify(proxy.records()).includes(SYNTHETIC_SECRET),
    JSON.stringify({
      status: e2eStatus.stdout,
      record: okRecord === undefined ? 'MISSING' : { remote: okRecord.remote, provider: okRecord.provider, subs: okRecord.substitutions },
      upstreamSawRealKey: upstreamAuth === 'Bearer ' + SYNTHETIC_SECRET,
    }),
  )

  console.log('==> P36-6 远端拿着真钥匙发请求 → 403 挡下，不转发')
  const beforeUpstream = upstream.seen.length
  const leakToken = NEG ? 'Bearer ' + placeholder : SYNTHETIC_SECRET
  const leakStatus = await remoteCurl(url, ['x-api-key: ' + leakToken, 'x-teleport-host: ' + HOST_LABEL])
  const rejectRecord = proxy.records().find((record) => record.outcome === 'rejected')
  const leakWarning = proxy.warnings().find((warning) => warning.code === 'proxy/real-credential-on-remote')
  expect(
    'P36-6',
    leakStatus.stdout === '403' &&
      rejectRecord !== undefined &&
      rejectRecord.reason === 'real-credential-on-remote' &&
      leakWarning !== undefined &&
      upstream.seen.length === beforeUpstream,
    JSON.stringify({ status: leakStatus.stdout, outcome: rejectRecord && rejectRecord.reason, upstreamDelta: upstream.seen.length - beforeUpstream }),
  )

  console.log('==> P36-7 代理只绑回环（带正向对照，证明这条不是空断言）')
  const lan = nonLoopbackIPv4()
  let loopbackOnly = false
  let controlReachable = false
  if (lan !== undefined) {
    // 正向对照：同样端口形态、但绑 0.0.0.0 的测量夹具，从宿主网卡地址应当连得上。
    // 这不是产品行为，只为让「连不上」这条断言可被证伪（见文件头变异 6）。
    const control = http.createServer((_req, res) => res.end('control'))
    const controlPort = await new Promise((resolve) => {
      control.listen(0, '0.0.0.0', () => resolve(control.address().port))
    })
    controlReachable = await connectOnce(lan, controlPort)
    // 对照必须**保持监听**直到测量完成：先 close 再连会得到「连不上」，
    // 那样变异 6 点过去也照样绿（实测踩过），断言就变成空断言。
    const measuredPort = NEG ? controlPort : proxyPort
    loopbackOnly = !(await connectOnce(lan, measuredPort))
    control.close()
  }
  expect(
    'P36-7',
    lan !== undefined ? loopbackOnly && controlReachable : true,
    JSON.stringify({ lan: lan ?? 'NONE', proxyReachableOnLan: !loopbackOnly, controlReachable }),
  )

  // ---- 收尾 ----
  cleanup()
  function cleanup() {
    try {
      relay.kill()
    } catch {}
    try {
      globalThis.__p36Bridge?.dispose()
    } catch {}
  }
  await proxy.stop()
  await new Promise((resolve) => upstream.server.close(() => resolve()))
  await inDistro('rm -rf ' + REMOTE_DIR + ' && test ! -e ' + REMOTE_DIR + ' && echo CLEANED')

  const expected = ['P36-2', 'P36-3', 'P36-4', 'P36-5', 'P36-6']
  if (lan !== undefined) expected.push('P36-7')
  const sorted = [...failures].sort()
  const matches = NEG ? sorted.length === expected.length && expected.every((name, index) => name === sorted[index]) : true
  if (NEG) {
    console.log('')
    console.log('  ' + (matches ? 'PASS' : 'FAIL') + ' NEGATIVE_CONTROL 失败集=' + JSON.stringify(sorted) + ' 期望=' + JSON.stringify(expected))
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
