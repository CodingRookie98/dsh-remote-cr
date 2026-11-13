/**
 * A5 的「取消代价」实测：在 `attach` 阶段取消后，远端 dsh 多久不再监听。
 *
 * 为什么单独一个脚本而不是塞进 `ssh-panel/probe.cjs`：
 * 探针的取消点必须落在页面能抓到的阶段（`bootstrap`/`launch`），那时远端往往还没开始监听；
 * 而「端口回收」要的是**远端已经在监听**的时刻 —— 那时页面快照（300ms）已经追不上
 * `tunnel → attach` 的窗口，会「点晚」（取消落在接入完成之后）。所以这里直接驱动产品
 * `ProjectionService`，把取消点钉在 `phase === 'attach'`。
 *
 * 跑法：`MSYS_NO_PATHCONV=1 node spikes/m2/ssh-e2e/cancel-reclaim.ts [alias] [remoteRoot]`
 * 产物：同目录 `measurements.cancel.json`（端口何时不再监听、取消是否落定）。
 *
 * 口径：`architecture.md` §8.5 —— 取消只回滚「本次新建」的连接；端口何时释放由
 * 看门狗在 ssh 结束后完成，**取消本身不承诺立刻释放**。
 */
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveAnchorPath } from '../../../src/local/backend/ssh/anchor-runtime.ts'
import { readSshConfig, resolveSshTarget } from '../../../src/local/backend/ssh/config.ts'
import { createLiveConnect } from '../../../src/local/projection/live.ts'
import { ProjectionService, type ConnectTarget } from '../../../src/local/projection/service.ts'
import { ProjectionStore } from '../../../src/local/projection/store.ts'
import { defaultTimers } from '../../../src/shared/reconnect.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ALIAS = process.argv[2] ?? 'gcp'
const RAW_ROOT = process.env['TELEPORT_REMOTE_ROOT'] ?? process.argv[3] ?? 'home/hui/workspace'
const PORT = Number(process.env['REMOTE_PORT'] ?? '8945')
const HOME = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
if (RAW_ROOT.includes(String.fromCharCode(92)) || /^[A-Za-z]:/.test(RAW_ROOT)) {
  console.error('remoteRoot 被改写成 Windows 路径了：' + RAW_ROOT)
  process.exit(2)
}
const REMOTE_ROOT = RAW_ROOT.startsWith('/') ? RAW_ROOT : '/' + RAW_ROOT
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

const configFile = join(HOME, '.ssh', 'config')
const config = readSshConfig({ file: configFile, homeDir: HOME })
const resolved = resolveSshTarget(config.parsed, ALIAS, { homeDir: HOME, file: configFile })
if (resolved.target === undefined) {
  console.error('没有别名 ' + ALIAS)
  process.exit(2)
}
const anchor = await resolveAnchorPath({ homeDir: HOME, target: resolved.target, remotePath: REMOTE_ROOT })
const target: ConnectTarget = { backend: 'ssh', alias: ALIAS, port: PORT, remoteRoot: anchor.remotePath }
const connectLive = createLiveConnect({ ssh: { homeDir: HOME, authFor: async () => ({ kind: 'key' as const }) } })
const service = new ProjectionService({
  store: new ProjectionStore(),
  timers: defaultTimers,
  connect: async (want: ConnectTarget) => connectLive(want),
})

/** 远端端口是否在监听：只认端口，不认进程名（`pgrep -f` 会命中执行它的 shell 自己）。 */
function remotePortBusy(): boolean {
  const out = spawnSync('ssh', ['-n', '-o', 'BatchMode=yes', ALIAS, '(command -v ss >/dev/null && ss -ltn) || netstat -ltn'], {
    encoding: 'utf8',
    timeout: 20_000,
  })
  return String(out.stdout ?? '').split(/\r?\n/).some((line) => line.includes(':' + String(PORT) + ' '))
}

const started = Date.now()
const controller = new AbortController()
const running = service.attach(target, { remotePath: anchor.remotePath, localPath: anchor.localPath }, { signal: controller.signal })
let phase = ''
const untilPhase = Date.now() + 90_000
while (Date.now() < untilPhase) {
  phase = service.attachProgress?.phase ?? ''
  if (phase === 'attach') break
  await sleep(20)
}
const abortedAt = Date.now()
controller.abort()
let cancelled = false
try {
  await running
} catch (error) {
  cancelled = (error as { code?: string }).code === 'remote/cancelled'
}
const busyAtAbort = remotePortBusy()
const pollFrom = Date.now()
let freedAfterMs: number | null = null
while (Date.now() - pollFrom < 90_000) {
  if (!remotePortBusy()) {
    freedAfterMs = Date.now() - pollFrom
    break
  }
  await sleep(2_000)
}
const result = {
  at: new Date().toISOString(),
  alias: ALIAS,
  remotePort: PORT,
  attachMs: abortedAt - started,
  cancelPhase: phase,
  cancelled,
  connected: service.connected,
  busyAtAbort,
  freedAfterMs,
}
console.log(JSON.stringify(result, null, 2))
await mkdir(HERE, { recursive: true })
const file = join(HERE, 'measurements.cancel.json')
await writeFile(file, JSON.stringify(result, null, 2))
console.log('落盘：' + file)
service.recycle()
