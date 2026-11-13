/**
 * S9 · SSH 真机闭环证据（M2 的 M1-p352 对应物）
 *
 * 七步都必须是**真的在远端发生**的：配置解析 → 主机密钥 TOFU → 单 channel 探测 →
 * 引导器实跑（把 dsh 装进 staging 前缀）→ 启动 dsh 并同一条连接挂 -L/-R →
 * 经隧道读到远端 dsh 的 HTTP 响应、并在远端执行命令 → 退出回收。
 *
 * 为什么不用 GUI 驱动：M1 的 p352 走 GUI 是因为当时的风险在「面板/向导/投影」；
 * M2 的新风险全在传输层（认证、指纹、隧道方向、看门狗），这些在 GUI 之外就能
 * 而且必须更严格地断言——GUI 只是把这些能力投影出去。
 *
 * 负控：NEGATIVE_CONTROL=1 时把远端启动命令换成不存在的路径，
 * 期望恰好 S9-5/S9-6/S9-7 三步红，其余四步照绿——证明这套探针能区分
 * 「传输能力坏了」与「探针自己坏了」。
 *
 * 用法：
 *   node spikes/m2/ssh-exit-demo/probe.ts
 *   NEGATIVE_CONTROL=1 node spikes/m2/ssh-exit-demo/probe.ts
 *   TELEPORT_SSH_ALIAS=<ssh config 里的别名> node spikes/m2/ssh-exit-demo/probe.ts
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFile } from 'node:fs/promises'

import {
  DEFAULT_MIRRORS,
  emptyBootstrapState,
  markStep,
  planBootstrap,
  readBootstrapState,
  runBootstrap,
  stagingDirFor,
  writeBootstrapState,
} from '../../../src/local/backend/ssh/bootstrap.ts'
import { connectRemote } from '../../../src/local/backend/ssh/connect.ts'
import { readSshConfig, resolveSshTarget, type SshTarget } from '../../../src/local/backend/ssh/config.ts'
import { WATCHDOG_KILLED_MARK, launchSshDsh } from '../../../src/local/backend/ssh/launch.ts'
import { probeSshTarget, shellQuote } from '../../../src/local/backend/ssh/probe.ts'
import { runSsh, type SshAuth } from '../../../src/local/backend/ssh/transport.ts'

const ALIAS = process.env['TELEPORT_SSH_ALIAS'] ?? 'gcp'
const NEGATIVE = process.env['NEGATIVE_CONTROL'] === '1'
const NEG_EXPECTED_FAILURES = ['S9-5', 'S9-6', 'S9-7']
const REMOTE_PORT = 8987
/** npm 上 @deepseek-ai/dsh 的最新发布版；固定下来才可复现。 */
const DSH_INSTALL_VERSION = '0.2.2-rc.1'
const homeDir = homedir()
const proxyHits: string[] = []

interface StepResult {
  readonly id: string
  readonly title: string
  readonly ok: boolean
  readonly ms: number
  readonly error?: string
}

const results: StepResult[] = []

async function step(id: string, title: string, run: () => Promise<void>): Promise<void> {
  const started = Date.now()
  try {
    await run()
    results.push({ id, title, ok: true, ms: Date.now() - started })
    console.log('  ok   ' + id + '  ' + title + '  (' + String(Date.now() - started) + 'ms)')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    results.push({ id, title, ok: false, ms: Date.now() - started, error: message })
    console.log('  FAIL ' + id + '  ' + title + '  (' + String(Date.now() - started) + 'ms)')
    console.log('       ' + message.split('\n').slice(0, 8).join('\n       '))
  }
}

async function tcpOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host, port })
    const done = (value: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(3000)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

type Probe = Awaited<ReturnType<typeof probeSshTarget>>
type Handle = Awaited<ReturnType<typeof launchSshDsh>>

async function main(): Promise<number> {
  console.log('S9 · SSH 真机闭环（alias=' + ALIAS + (NEGATIVE ? ', NEGATIVE_CONTROL' : '') + '）')
  const configPath = join(homeDir, '.ssh', 'config')
  let target: SshTarget | undefined
  const auth: SshAuth = { kind: 'key' }

  const remote = async (script: string, deadlineMs = 600_000) => {
    assert.ok(target !== undefined, '目标还没解析出来')
    return await runSsh({
      target,
      auth,
      homeDir,
      command: ['sh', '-c', shellQuote(script)],
      deadlineMs,
      allowFailure: true,
    })
  }

  await step('S9-1', '配置解析：从真实 ssh config 解析出目标', async () => {
    const read = readSshConfig({ file: configPath, homeDir })
    const resolved = resolveSshTarget(read.parsed, ALIAS, { homeDir, file: configPath })
    assert.equal(
      read.problems.length,
      0,
      '配置本身有问题：' + read.problems.map((item) => item.file + ':' + String(item.line) + ' ' + item.message).join('；'),
    )
    assert.ok(
      resolved.target !== undefined,
      '别名 ' + ALIAS + ' 没解析出目标：' + resolved.problems.map((item) => item.message).join('；'),
    )
    target = resolved.target
    assert.ok(resolved.target.hostName.length > 0)
    assert.ok(resolved.target.port > 0)
  })

  await step('S9-2', '主机密钥 TOFU：首见入库，二次认账', async () => {
    const first = await connectRemote({ homeDir, target: target!, auth })
    assert.equal(
      first.hostKeyObserved,
      true,
      '没有取到主机指纹（ssh stderr 与 keyscan 都没有）：source=' + first.hostKeySource,
    )
    const second = await connectRemote({ homeDir, target: target!, auth })
    assert.equal(second.hostKey.state, 'known', '第二次连接仍不是 known：' + second.hostKey.state)
    // 第二次会刷新 lastSeen（有意的），但 firstSeen 必须不动——那才证明「还是同一把钥匙」。
    assert.equal(second.hostKey.changed.length, 0, '第二次连接报告了指纹变更')
  })

  let facts: Probe | undefined
  await step('S9-3', '单 channel 探测：平台/架构/内核/home 一次拿全', async () => {
    facts = await probeSshTarget({ homeDir, target: target!, auth })
    assert.equal(facts.parsed.complete, true, '没有结束标记')
    assert.ok(facts.system.platform !== undefined, '没拿到 platform')
    assert.ok(facts.system.arch !== undefined, '没拿到 arch')
    assert.ok(facts.probe.home.length > 0, '没拿到 home')
  })

  let dshCommand = ''
  let stagingDir = ''
  await step('S9-4', '引导器：staging 0700 + tar 预检 + dsh 装进前缀', async () => {
    assert.ok(facts !== undefined)
    assert.ok(target !== undefined)
    // 注意：staging 建在**远端**，所以这里必须用远端 home，不是本地 homedir()。
    // 用本地路径会得到远端的一个名为 C:/Users/... 的相对目录，每条 mkdir 都 exit 0。
    stagingDir = stagingDirFor(facts.probe.home, target)
    const anchorId = stagingDir.split(/[\\/]/).pop() ?? ''
    // 账本落**本地**：writeBootstrapState/readBootstrapState 是本地文件 API。
    // 用远端路径会写到 D:\home\hui\... 那种地方（2026-11-12 真机踩过）。
    const statePath = join(tmpdir(), 'teleport-s9-state-' + anchorId + '.json')
    const loaded = await readBootstrapState(statePath, anchorId)
    const state = loaded.ok === true ? loaded.state : emptyBootstrapState(anchorId)
    const plan = planBootstrap({
      facts: { node: facts.probe.nodeVersion, dsh: facts.probe.dshVersion },
      state,
      stagingDir,
      dshHome: facts.probe.home + '/.dsh',
      mirror: DEFAULT_MIRRORS[0]?.registry,
      dshVersion: DSH_INSTALL_VERSION,
      platform: facts.system.platform,
      arch: facts.system.arch,
    })
    const outcome = await runBootstrap(plan, async (script) => {
      const result = await remote(script)
      return { code: result.code, stdout: result.stdout, stderr: result.stderr }
    })
    assert.equal(
      outcome.ok,
      true,
      '引导失败于 ' + String(outcome.failed?.id) + '（退出码 ' + String(outcome.failed?.code) + '）：' + String(outcome.failed?.tail),
    )
    let next = state
    for (const id of outcome.executed) next = markStep(next, id, 'S9 实跑通过')
    await writeBootstrapState(statePath, next)
    dshCommand = stagingDir + '/npm/bin/dsh'
    const check = await remote('test -x ' + shellQuote(dshCommand) + ' && ' + shellQuote(dshCommand) + ' --version')
    assert.equal(check.code, 0, 'staging 里没有可执行的 dsh：' + check.stderr.trim().slice(-300))
  })

  let handle: Handle | undefined
  let proxyServer: ReturnType<typeof createServer> | undefined
  await step('S9-5', '启动 dsh + 同一条连接挂 -L/-R，远端请求真的到达本机代理', async () => {
    assert.ok(target !== undefined)
    proxyServer = createServer((request, response) => {
      proxyHits.push(String(request.url))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true,"from":"local-proxy"}')
    })
    await new Promise<void>((resolve) => proxyServer!.listen(0, '127.0.0.1', () => resolve()))
    const address = proxyServer.address()
    const proxyPort = typeof address === 'object' && address !== null ? address.port : 0
    assert.ok(proxyPort > 0, '本地代理没拿到端口')

    handle = await launchSshDsh({
      homeDir,
      target: target!,
      auth,
      remoteRoot: '~',
      remotePort: REMOTE_PORT,
      proxyPort,
      argvPrefix: [NEGATIVE ? '/nonexistent/dsh' : dshCommand],
      cwd: null,
      timeoutMs: 180_000,
    })
    assert.equal(handle.endpoint.host, '127.0.0.1', '端点没有改写成本地隧道口')
    assert.ok(handle.endpoint.port > 0)
    assert.ok(await tcpOpen(handle.localPort), '本地 -L 端口连不上')
    assert.ok(handle.remoteProxyPort !== undefined, '没有解析到 -R 分配到的端口')

    const curl = await remote(
      'curl -sS -m 8 http://127.0.0.1:' + String(handle.remoteProxyPort) + '/probe-from-remote',
    )
    assert.equal(curl.code, 0, '远端连不上反向隧道：' + curl.stderr.trim().slice(-300))
    assert.match(curl.stdout, /local-proxy/, '远端拿到的不是本机代理的响应：' + curl.stdout.slice(0, 200))
    assert.ok(proxyHits.includes('/probe-from-remote'), '本机代理没收到远端请求，反向隧道是假的')
  })

  await step('S9-6', '经 -L 读到远端 dsh 的 HTTP 响应，远端命令与探测一致', async () => {
    assert.ok(handle !== undefined)
    assert.ok(facts !== undefined)
    // 必须从**本地**打这个端口：-L 的监听端在本机，远端根本没有 localPort。
    // 2026-11-12 之前这里在远端 curl 本地端口，永远是 000。
    const response = await fetch('http://127.0.0.1:' + String(handle.localPort) + '/', { redirect: 'manual' })
    assert.ok(
      response.status >= 100 && response.status <= 599,
      '经 -L 的本机隧道口没有返回 HTTP 状态：' + String(response.status),
    )
    const live = await remote('pwd; uname -s; uname -m')
    const lines = live.stdout.trim().split(/\r?\n/)
    assert.equal(lines[lines.length - 2], facts.system.platform, '远端 platform 与探测不一致')
    assert.equal(lines[lines.length - 1], facts.system.arch, '远端 arch 与探测不一致')
  })

  await step('S9-7', '退出回收：远端 dsh 被看门狗收掉，本地隧道口关闭', async () => {
    assert.ok(handle !== undefined)
    const logBefore = handle.log()
    const hadKilledBefore = logBefore.includes(WATCHDOG_KILLED_MARK)
    const disposeAt = Date.now()
    const outcome = await handle.dispose()
    const disposeMs = Date.now() - disposeAt
    const logAfter = handle.log()
    const hadKilledAfter = logAfter.includes(WATCHDOG_KILLED_MARK)
    const localPort = handle.localPort
    // 先取证再断言：clean 判据是「看门狗标记」，端口是「事实」。两者不符时要看得见差在哪。
    await new Promise((resolve) => setTimeout(resolve, 800))
    // 不能用 pgrep：执行这条命令的远端 sh 自己命令行里就含 dshCommand，永远匹配到自己。
    // dsh 活着就占着 remotePort，查监听才是不会自证的证据。
    const listening = await remote(
      '(command -v ss >/dev/null 2>&1 && ss -ltn || netstat -ltn) 2>/dev/null | grep -c ' +
        shellQuote(':' + String(REMOTE_PORT)) +
        ' || true',
    )
    const stillOpen = await tcpOpen(localPort)
    const tail = handle.log().slice(-600)
    assert.equal(
      outcome,
      true,
      '回收报了不干净；远端仍监听 ' + String(REMOTE_PORT) + ' 的条数=' + listening.stdout.trim() +
        '；隧道口还开着=' + String(stillOpen) +
        '；dispose 前日志已含 KILLED=' + String(hadKilledBefore) +
        '；dispose 后已含 KILLED=' + String(hadKilledAfter) +
        '；dispose 耗时=' + String(disposeMs) + 'ms' +
        '；日志长 ' + String(logBefore.length) + '→' + String(logAfter.length) +
        '；日志尾：' + tail,
    )
    assert.equal(stillOpen, false, '本地隧道口还开着')
    assert.equal(listening.stdout.trim(), '0', '远端还在监听 ' + String(REMOTE_PORT) + '：' + listening.stdout.trim())
  })

  proxyServer?.close()

  const failed = results.filter((item) => !item.ok).map((item) => item.id)
  const passed = results.filter((item) => item.ok).length
  console.log('')
  console.log(
    String(passed) + '/' + String(results.length) + ' passed；失败：' + (failed.length === 0 ? '无' : failed.join(',')),
  )
  const report = {
    generatedAt: new Date().toISOString(),
    alias: ALIAS,
    negativeControl: NEGATIVE,
    steps: results,
    failed,
  }
  const reportPath = join(import.meta.dirname, NEGATIVE ? 'measurements.neg.json' : 'measurements.json')
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8')

  if (NEGATIVE) {
    const same =
      failed.length === NEG_EXPECTED_FAILURES.length && NEG_EXPECTED_FAILURES.every((id) => failed.includes(id))
    console.log(same ? 'NEGATIVE CONTROL OK' : 'NEGATIVE CONTROL MISMATCH：期望 ' + NEG_EXPECTED_FAILURES.join(','))
    return same ? 0 : 1
  }
  return failed.length === 0 ? 0 : 1
}

process.exitCode = await main()
