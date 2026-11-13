/**
 * M3-2b「结束远端」的真机验证（**服务层路径**：不是浏览器点击）。
 *
 * 验的是：`service.stopRemote()` 之后远端 dsh 真的消失、端口释放。
 * 覆盖的是「普通连接 → handle.dispose()（EXIT 行 → 看门狗 kill）」这条；
 * 复用连接的「按登记 pid 杀」是另一条实现路径，未在这里覆盖（记账）。
 */
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveAnchorPath } from '../../src/local/backend/ssh/anchor-runtime.ts'
import { readSshConfig, resolveSshTarget } from '../../src/local/backend/ssh/config.ts'
import { createLiveConnect } from '../../src/local/projection/live.ts'
import { ProjectionService, type ConnectTarget } from '../../src/local/projection/service.ts'
import { ProjectionStore } from '../../src/local/projection/store.ts'
import { defaultTimers } from '../../src/shared/reconnect.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ALIAS = process.argv[2] ?? 'gcp'
const PORT = Number(process.env['REMOTE_PORT'] ?? '8949')
const HOME = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
const cfg = join(HOME, '.ssh', 'config')
const config = readSshConfig({ file: cfg, homeDir: HOME })
const resolved = resolveSshTarget(config.parsed, ALIAS, { homeDir: HOME, file: cfg })
if (resolved.target === undefined) {
  console.error('没有别名 ' + ALIAS)
  process.exit(2)
}
const anchor = await resolveAnchorPath({ homeDir: HOME, target: resolved.target, remotePath: '/home/hui/workspace' })
const target: ConnectTarget = { backend: 'ssh', alias: ALIAS, port: PORT, remoteRoot: anchor.remotePath }
const live = createLiveConnect({ ssh: { homeDir: HOME, authFor: async () => ({ kind: 'key' as const }) } })
const service = new ProjectionService({
  store: new ProjectionStore(),
  timers: defaultTimers,
  connect: async (want: ConnectTarget) => live(want),
})

const ssh = (script: string, timeoutMs = 30_000): string =>
  String(spawnSync('ssh', ['-n', '-o', 'BatchMode=yes', ALIAS, script], { encoding: 'utf8', timeout: timeoutMs }).stdout ?? '')
const portBusy = (): boolean =>
  ssh('(command -v ss >/dev/null && ss -ltn) || netstat -ltn')
    .split(/\r?\n/)
    .some((line) => line.includes(':' + String(PORT) + ' '))

const started = Date.now()
await service.attach(target, { remotePath: anchor.remotePath, localPath: anchor.localPath })
const attachMs = Date.now() - started
const busyBefore = portBusy()
const stopAt = Date.now()
await service.stopRemote()
let freedMs: number | null = null
while (Date.now() - stopAt < 60_000) {
  if (!portBusy()) {
    freedMs = Date.now() - stopAt
    break
  }
  await sleep(500)
}
const result = {
  at: new Date().toISOString(),
  alias: ALIAS,
  remotePort: PORT,
  attachMs,
  busyBefore,
  connectedAfterStop: service.connected,
  freedAfterMs: freedMs,
}
console.log(JSON.stringify(result, null, 2))
await mkdir(HERE, { recursive: true })
await writeFile(join(HERE, 'measurements.stop-remote.json'), JSON.stringify(result, null, 2))
console.log('落盘：' + join(HERE, 'measurements.stop-remote.json'))
