/**
 * M2 出口门槛 1：远端**真的**能经反向隧道打到本机凭据代理，并在这里被换成真值。
 *
 * 为什么用真机而不是单测：这条链有四个只有真机才会坏的接缝 ——
 * `ssh -R 127.0.0.1:0:`（端口由服务端分配）、远端回环监听、代理的占位串校验、
 * 以及「真值只出现在本机」这条铁律。单测能证明代理自身会换值，证明不了隧道通。
 *
 * 走的**就是产品路径**：`createLiveConnect({ ssh: { proxyPort } })` —— 与 `src/index.ts`
 * 装配的是同一个函数、同一个 `launchSshDsh`。所以它同时验证了 S10-A 那一片接线。
 *
 * 跑法：`MSYS_NO_PATHCONV=1 node spikes/m2/ssh-e2e/proxy-ingress.ts [alias] [remoteRoot]`
 * 负控：`NEGATIVE_CONTROL=1` —— 不给 `proxyPort`（等于代理没接进链路），
 * PX-2/PX-3/PX-4 必须全红；PX-1 仍应绿（代理自己活得好好的）。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readSshConfig, resolveSshTarget } from '../../../src/local/backend/ssh/config.ts'
import { LocalCredentials } from '../../../src/local/proxy/credentials.ts'
import { startCredentialProxy, type CredentialProxyRuntime } from '../../../src/local/proxy/runtime.ts'
import { createLiveConnect } from '../../../src/local/projection/live.ts'
import type { ConnectTarget, RemoteConnection } from '../../../src/local/projection/service.ts'

const ALIAS = process.argv[2] ?? 'gcp'
const RAW_ROOT = process.env['TELEPORT_REMOTE_ROOT'] ?? process.argv[3] ?? 'home/hui/workspace'
const NEGATIVE = process.env['NEGATIVE_CONTROL'] === '1'
const HOME_DIR = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
const REMOTE_PORT = Number(process.env['REMOTE_PORT'] ?? '8951')
const REF = 'DEEPSEEK_API_KEY'
const REAL_VALUE = 'sk-real-probe-value'
const REMOTE_ROOT = RAW_ROOT.startsWith('/') ? RAW_ROOT : '/' + RAW_ROOT

interface Measurement { readonly name: string; readonly ok: boolean; readonly detail: string }
const results: Measurement[] = []
function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail })
  console.log((ok ? '  ok   ' : '  FAIL ') + name + ' — ' + detail)
}

interface Seen { path: string; authorization: string | undefined; body: string }
async function startFakeUpstream(): Promise<{ base: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      seen.push({
        path: req.url ?? '/',
        authorization: req.headers['authorization'] as string | undefined,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'fake-upstream', ok: true }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const base = 'http://127.0.0.1:' + String((server.address() as AddressInfo).port)
  return { base, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

/** 在**另一条** ssh 会话里打远端回环：`-R` 的监听口绑定在远端 127.0.0.1 上，跨会话可见。 */
async function sshRun(command: string, timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', ALIAS, command], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const timer = setTimeout(() => { child.kill() }, timeoutMs)
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }) })
  })
}

const configFile = join(HOME_DIR, '.ssh', 'config')
const config = readSshConfig({ file: configFile, homeDir: HOME_DIR })
const resolved = resolveSshTarget(config.parsed, ALIAS, { homeDir: HOME_DIR, file: configFile })
if (resolved.target === undefined) {
  console.error('没有别名 ' + ALIAS + '：' + resolved.problems.map((item) => item.message).join(' / '))
  process.exit(2)
}

const upstream = await startFakeUpstream()
const credentials = new LocalCredentials({ env: {}, refs: new Map([[REF, REAL_VALUE]]) })
const proxy: CredentialProxyRuntime = await startCredentialProxy({
  credentials,
  resolveUpstream: (provider) => (provider === 'deepseek' ? upstream.base : undefined),
})
const placeholder = proxy.env[REF] ?? ''

const health = await fetch('http://127.0.0.1:' + String(proxy.port) + '/healthz')
record('PX-1 代理起在回环上且健康', health.status === 200, 'port=' + String(proxy.port) + ' status=' + String(health.status))

const target: ConnectTarget = { backend: 'ssh', alias: ALIAS, port: REMOTE_PORT, remoteRoot: REMOTE_ROOT }
const connectLive = createLiveConnect({
  ssh: {
    homeDir: HOME_DIR,
    authFor: async () => ({ kind: 'key' as const }),
    ...(NEGATIVE ? {} : { proxyPort: proxy.port }),
  },
})

let connection: RemoteConnection | undefined
try {
  connection = await connectLive(target)
  const remoteProxyPort = connection.remoteProxyPort
  record(
    'PX-2 远端经 -R 拿到端口',
    typeof remoteProxyPort === 'number' && remoteProxyPort > 0,
    'remoteProxyPort=' + String(remoteProxyPort),
  )

  const url = 'http://127.0.0.1:' + String(remoteProxyPort ?? 0) + '/r/deepseek/chat/completions'
  const curl = await sshRun(
    "curl -sS -m 20 -H 'content-type: application/json' -H 'authorization: Bearer " + placeholder + "' -d '{\"probe\":1}' " + url,
  )
  record('PX-3 远端 curl 打回本机代理', curl.code === 0 && curl.stdout.includes('fake-upstream'), 'exit=' + String(curl.code) + ' body=' + curl.stdout.slice(0, 120))

  const record0 = proxy.proxy.records().at(-1)
  const substituted = record0?.substitutions.some((item) => item.ref === REF) ?? false
  record(
    'PX-4 代理侧记录了入站与替换',
    record0 !== undefined && record0.outcome === 'ok' && record0.provider === 'deepseek' && substituted,
    'outcome=' + String(record0?.outcome) + ' provider=' + String(record0?.provider) + ' subs=' + JSON.stringify(record0?.substitutions ?? []),
  )

  const upstreamSaw = upstream.seen.at(-1)
  record(
    'PX-5 假上游收到的是真值（占位串不出本机）',
    upstreamSaw?.authorization === 'Bearer ' + REAL_VALUE,
    'upstream authorization=' + String(upstreamSaw?.authorization),
  )

  // 反向断言：远端绝不该看到真值。查远端日志里有没有它 —— 这是「凭据不出本机」的可执行版本。
  const grep = await sshRun("grep -c '" + REAL_VALUE + "' ~/.dsh-teleport/*.log 2>/dev/null | head -1 || true")
  record(
    'PX-6 远端看不到真值',
    !grep.stdout.includes(String(REAL_VALUE)),
    'remote grep=' + JSON.stringify(grep.stdout.trim()),
  )
} catch (error) {
  record('PX-2 远端经 -R 拿到端口', false, '连不上：' + (error instanceof Error ? error.message : String(error)))
} finally {
  connection?.dispose()
  await new Promise<void>((resolve) => setTimeout(resolve, 1_000))
  await proxy.stop()
  await upstream.close()
}

const failed = results.filter((item) => !item.ok).map((item) => item.name)
console.log('')
console.log(String(results.length - failed.length) + '/' + String(results.length) + ' passed')
if (NEGATIVE) {
  const expected = ['PX-2 远端经 -R 拿到端口', 'PX-3 远端 curl 打回本机代理', 'PX-4 代理侧记录了入站与替换', 'PX-5 假上游收到的是真值（占位串不出本机）']
  const unexpected = failed.filter((name) => !expected.includes(name))
  if (unexpected.length > 0) {
    console.log('NEGATIVE CONTROL BROKEN：这些不该红 —— ' + unexpected.join(', '))
    process.exit(1)
  }
  console.log('NEGATIVE CONTROL OK (failed: ' + failed.join(', ') + ')')
  process.exit(0)
}
if (failed.length > 0) {
  console.log('failed: ' + failed.join(', '))
  process.exit(1)
}