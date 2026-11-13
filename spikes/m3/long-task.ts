/**
 * M3-2 的事实探针：**本地退出之后，远端 dsh 与它上面跑的任务还在吗？**
 *
 * 这一条决定了「长任务」能不能做。当前设计里远端 dsh 由看门狗托管：本地 ssh 通道一断，
 * 看门狗读到 stdin EOF 就把远端进程收掉（A7「不留孤儿」的保证）。如果事实如此，
 * M3-2 必须先引入「驻留模式」，否则「关电脑后任务继续跑」是空话。
 *
 * 跑法：`MSYS_NO_PATHCONV=1 node spikes/m3/long-task.ts [alias] [waitSeconds]`
 * 产物：同目录 `measurements.long-task.json`。
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
const WAIT_S = Number(process.argv[3] ?? process.env['WAIT_S'] ?? '60')
const PORT = Number(process.env['REMOTE_PORT'] ?? '8946')
const HOME = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

const configFile = join(HOME, '.ssh', 'config')
const config = readSshConfig({ file: configFile, homeDir: HOME })
const resolved = resolveSshTarget(config.parsed, ALIAS, { homeDir: HOME, file: configFile })
if (resolved.target === undefined) {
  console.error('没有别名 ' + ALIAS)
  process.exit(2)
}
const anchor = await resolveAnchorPath({ homeDir: HOME, target: resolved.target, remotePath: '/home/hui/workspace' })
const target: ConnectTarget = { backend: 'ssh', alias: ALIAS, port: PORT, remoteRoot: anchor.remotePath }
const connectLive = createLiveConnect({ ssh: { homeDir: HOME, authFor: async () => ({ kind: 'key' as const }) } })
const makeService = (): ProjectionService =>
  new ProjectionService({ store: new ProjectionStore(), timers: defaultTimers, connect: async (want: ConnectTarget) => connectLive(want) })

const ssh = (script: string, timeoutMs = 30_000): string => {
  const out = spawnSync('ssh', ['-n', '-o', 'BatchMode=yes', ALIAS, script], { encoding: 'utf8', timeout: timeoutMs })
  return String(out.stdout ?? '')
}

/** 远端端口是否在监听（只认端口，不认进程名）。 */
const portBusy = (): boolean =>
  ssh('(command -v ss >/dev/null && ss -ltn) || netstat -ltn')
    .split(/\r?\n/)
    .some((line) => line.includes(':' + String(PORT) + ' '))

/** 按端口找远端 dsh 的 pid（/proc inode 法；ss -p 在非 root 下不给 pid）。 */
const dshPid = (): number | null => {
  const pidExpr = 'pid=\$' + '{path#/proc/}'
  const cutExpr = 'pid=\$' + '{pid%%/*}'
  const script = [
    'hex=$(printf "%04X" ' + String(PORT) + ')',
    'inodes=$(awk -v h="$hex" \'$2 ~ (":" h "$") && $4 == "0A" {print $10}\' /proc/net/tcp /proc/net/tcp6 2>/dev/null | sort -u)',
    'for inode in $inodes; do',
    '  for path in /proc/[0-9]*/fd/*; do',
    '    target=$(readlink "$path" 2>/dev/null) || continue',
    '    [ "$target" = "socket:[$inode]" ] || continue',
    '    ' + pidExpr + '; ' + cutExpr + '; echo "$pid"; exit 0',
    '  done',
    'done',
    'echo 0',
  ].join('\n')
  const pid = Number(ssh(script).trim())
  return Number.isFinite(pid) && pid > 0 ? pid : null
}

const started = Date.now()
const service = makeService()
const attached = await service.attach(target, { remotePath: anchor.remotePath, localPath: anchor.localPath })
const workspaceId = attached.workspace.id
const session = await service.createSession(workspaceId)
const pidBefore = dshPid()
// 远端长任务：不挂会话，纯 nohup，用来判断「本地退出 N 秒后它还在不在」。
const token = 'LONG' + String(Date.now())
const taskScript = 'nohup sh -c \'sleep ' + String(WAIT_S + 60) + '; echo done > /tmp/' + token + '\' >/dev/null 2>&1 & echo $!'
ssh(taskScript)
const taskPid = ssh('pgrep -f "sleep ' + String(WAIT_S + 60) + '" | head -1').trim()
console.log('attached in ' + String(Date.now() - started) + 'ms · workspace=' + workspaceId + ' · session=' + session.sessionId)
console.log('remote dsh pid=' + String(pidBefore) + ' · long task pid=' + taskPid + ' · portBusy=' + String(portBusy()))

// 模拟「关掉本地 GUI」：dispose 会连远端句柄一起收（看门狗读 EOF）。
service.dispose()
const disposedAt = Date.now()
await sleep(WAIT_S * 1000)
const pidAfterWait = dshPid()
const busyAfterWait = portBusy()
const taskAlive = ssh('kill -0 ' + (taskPid === '' ? '0' : taskPid) + ' 2>/dev/null && echo 1 || echo 0').trim() === '1'

// 重新接入，看会话是否还在（数据层面的「长任务」）。
const service2 = makeService()
let reattached: { workspaceId: string; sessions: number; sessionKept: boolean; error: string | null } = {
  workspaceId: '',
  sessions: 0,
  sessionKept: false,
  error: null,
}
try {
  const again = await service2.attach(target, { remotePath: anchor.remotePath, localPath: anchor.localPath })
  const snap = service2.snapshot()
  reattached = {
    workspaceId: again.workspace.id,
    sessions: snap.sessions.length,
    sessionKept: snap.sessions.some((item) => item.sessionId === session.sessionId),
    error: null,
  }
} catch (error) {
  reattached.error = String((error as { code?: string }).code ?? error)
}

const result = {
  at: new Date().toISOString(),
  alias: ALIAS,
  remotePort: PORT,
  waitSeconds: WAIT_S,
  attachMs: disposedAt - started,
  workspaceId,
  sessionId: session.sessionId,
  dshPidBeforeDispose: pidBefore,
  // 关键事实：本地 dispose 之后，远端 dsh 还活着吗？
  dshAliveAfterWait: pidAfterWait !== null,
  portBusyAfterWait: busyAfterWait,
  longTaskAlive: taskAlive,
  reattach: reattached,
}
console.log(JSON.stringify(result, null, 2))
await mkdir(HERE, { recursive: true })
const file = join(HERE, 'measurements.long-task.json')
await writeFile(file, JSON.stringify(result, null, 2))
console.log('落盘：' + file)
service2.recycle()
