/**
 * A7 的 SSH 侧真机取证：断线后**状态可见**、**自动退避真的在跑**、重连把远端拉回来、退出不留孤儿。
 *
 * 判据来自 `docs/design/requirements.md` A7 原文，不是自拟：
 *   「网络中断/远端重启后，工作区状态可见、可一键重连，远端进程可回收（不留孤儿）」。
 *
 * 与 M1 `spikes/m1/p351-reconnect` 的关系：WSL 侧那六条已经把语义证死；这里**不重复**它的
 * 面板点击（那是 S10-G / S10-J 的事），只补 SSH 侧缺的那一段 —— 同一套 `ProjectionService`
 * 在**真 SSH 连接**上，远端进程被杀之后：
 *
 *   A7-1 基线：attach 成功、`link=connected`、1 个工作区 online
 *   A7-2 断线可见：杀远端 dsh（按监听端口定位 pid）后下一次 RPC 被识别为传输层丢失
 *        （`remote/tunnel-unavailable` 或 `remote/disconnected`），link 离开 connected，
 *        投影条目**还在**但全部 offline
 *   A7-3 自动恢复：**不等手动操作**，第一档 2s 的自动重试把远端重新拉起来（端口重新监听）
 *   A7-4 重连后投影重建：仍 1 个工作区、**id 不变**、online（重连不是「连上就算」）
 *   A7-5 退出无孤儿：recycle 后远端端口不再监听
 *
 * 负控（`NEGATIVE_CONTROL=1`）：注入一个**永不触发**的 `ReconnectTimers`（产品接缝
 * `ProjectionServiceOptions.timers`）。传输层失败仍会被正确识别（A7-2 照绿），但自动重连
 * 这条链路被精确切掉 ⇒ A7-3 / A7-4 必须红，A7-1 / A7-2 / A7-5 必须绿。
 * 若负控把 A7-2 也打红，说明探针分不清「断线被识别」与「自动重连」。
 *
 * 跑法：`MSYS_NO_PATHCONV=1 node spikes/m2/ssh-e2e/reconnect.ts [alias] [remoteRoot]`
 * 第二个参数不带前导斜杠（Git Bash 会把 `/home/...` 改写成 `C:/Users/...`）。
 * 负控：`MSYS_NO_PATHCONV=1 NEGATIVE_CONTROL=1 node spikes/m2/ssh-e2e/reconnect.ts`
 */
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TeleportError } from '../../../src/local/backend/errors.ts'
import { resolveAnchorPath } from '../../../src/local/backend/ssh/anchor-runtime.ts'
import { readSshConfig, resolveSshTarget } from '../../../src/local/backend/ssh/config.ts'
import { createLiveConnect } from '../../../src/local/projection/live.ts'
import { ProjectionService, type ConnectTarget, type RemoteConnection } from '../../../src/local/projection/service.ts'
import { ProjectionStore } from '../../../src/local/projection/store.ts'
import type { ReconnectTimers } from '../../../src/shared/reconnect.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ALIAS = process.argv[2] ?? 'gcp'
const RAW_ROOT = process.env['TELEPORT_REMOTE_ROOT'] ?? process.argv[3] ?? 'home/hui/workspace'
const REMOTE_PORT = Number(process.env['REMOTE_PORT'] ?? '8941')
const NEGATIVE = process.env['NEGATIVE_CONTROL'] === '1'
const HOME_DIR = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
/**
 * 自动重连的预算。远端 dsh 冷启动在 gcp 上要几十秒（`live.ts` 记的 SSH 冷启动 66s），
 * 所以正向给 120s；负控下驱动根本不会触发，等 12s 足够判红。
 */
const RECONNECT_BUDGET_MS = Number(process.env['RECONNECT_BUDGET_MS'] ?? (NEGATIVE ? '12000' : '120000'))

const NEG_EXPECTED_FAILURES = ['A7-3', 'A7-3b', 'A7-4'] as const

if (RAW_ROOT.includes(String.fromCharCode(92)) || /^[A-Za-z]:/.test(RAW_ROOT)) {
  console.error('remoteRoot 被改写成 Windows 路径了：' + RAW_ROOT + '（去掉前导斜杠再传）')
  process.exit(2)
}
const REMOTE_ROOT = RAW_ROOT.startsWith('/') ? RAW_ROOT : '/' + RAW_ROOT

interface Measurement {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
  readonly ms?: number
}
const results: Measurement[] = []

function record(name: string, ok: boolean, detail: string, ms?: number): void {
  results.push(ms === undefined ? { name, ok, detail } : { name, ok, detail, ms })
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ms === undefined ? '' : ' (' + String(ms) + 'ms)') + ' — ' + detail)
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

// ── 远端：只认端口，不认进程名 ───────────────────────────────────────────────
// `pgrep -f <dsh 命令>` 会命中执行它的那个 shell 自己（S9 踩过），残留判定一律走监听端口。

function sshRun(script: string, timeoutMs = 60_000): { status: number | null; stdout: string; stderr: string } {
  const out = spawnSync('ssh', ['-n', '-o', 'BatchMode=yes', ALIAS, script], { encoding: 'utf8', timeout: timeoutMs })
  return { status: out.status, stdout: String(out.stdout ?? ''), stderr: String(out.stderr ?? '') }
}

function remotePortBusy(port: number): boolean {
  const out = sshRun('(command -v ss >/dev/null && ss -ltn) || netstat -ltn', 30_000)
  return out.stdout.split('\n').some((line) => line.includes(':' + String(port) + ' '))
}

/** 按端口找到远端 dsh 的 pid 并 `kill -9`；找不到就当已经死了（幂等）。 */
function killRemoteOnPort(port: number): string {
  // 不用 `ss -ltnp` 的 Process 列：gcp 上非 root 根本不打印 users:(("node",pid=...))，
  // 于是 pids 恒空、脚本静默地什么都不做（A7-2 首跑 portFreed=false、createSession 照常成功）。
  // 改成标准办法：从 /proc/net/tcp{,6} 取该端口的 LISTEN inode，再扫 /proc/*/fd 找持有者。
  const script = [
    'port=' + String(port),
    'hex=$(printf "%04X" "$port")',
    'inodes=$(awk -v h="$hex" \'$2 ~ (":" h "$") && $4 == "0A" {print $10}\' /proc/net/tcp /proc/net/tcp6 2>/dev/null | sort -u)',
    'pids=""',
    'for inode in $inodes; do',
    '  for path in /proc/[0-9]*/fd/*; do',
    '    target=$(readlink "$path" 2>/dev/null) || continue',
    '    [ "$target" = "socket:[$inode]" ] || continue',
    '    pid=${path#/proc/}; pid=${pid%%/*}',
    '    pids="$pids $pid"',
    '  done',
    'done',
    'for p in $pids; do kill -9 "$p" 2>/dev/null || true; done',
    'echo "killed:$pids"',
  ].join('\n')
  return sshRun(script, 60_000).stdout.trim()
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<{ ok: boolean; ms: number }> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return { ok: true, ms: Date.now() - started }
    await sleep(250)
  }
  return { ok: false, ms: Date.now() - started }
}

const configFile = join(HOME_DIR, '.ssh', 'config')
const config = readSshConfig({ file: configFile, homeDir: HOME_DIR })
const resolved = resolveSshTarget(config.parsed, ALIAS, { homeDir: HOME_DIR, file: configFile })
if (resolved.target === undefined) {
  console.error('没有别名 ' + ALIAS + '：' + resolved.problems.map((item) => item.message).join(' / '))
  process.exit(2)
}
const sshTarget = resolved.target
const anchor = await resolveAnchorPath({ homeDir: HOME_DIR, target: sshTarget, remotePath: REMOTE_ROOT })
const target: ConnectTarget = { backend: 'ssh', alias: ALIAS, port: REMOTE_PORT, remoteRoot: anchor.remotePath }
console.log('target: ' + ALIAS + ' → ' + sshTarget.user + '@' + sshTarget.hostName + ':' + String(sshTarget.port))
console.log('remoteRoot: ' + anchor.remotePath)
console.log('localPath: ' + anchor.localPath)
console.log('REMOTE_PORT: ' + String(REMOTE_PORT) + ' · 负控=' + String(NEGATIVE))

const connectLive = createLiveConnect({ ssh: { homeDir: HOME_DIR, authFor: async () => ({ kind: 'key' as const }) } })

/**
 * 负控的变异点：`schedule` 收下任务但**永不执行**。
 *
 * 这是产品留的接缝（`ProjectionServiceOptions.timers`），不是给探针开后门：
 * 它切掉的正是「自动重连」这一层，而「识别传输层失败」这段逻辑照常跑 —— 两条断言组
 * 因此分得开。返回的 handle 随便给一个不透明对象，`cancel` 什么都不用做。
 */
const deadTimers: ReconnectTimers = {
  schedule: () => ({ never: true }),
  cancel: () => undefined,
}

const service = new ProjectionService({
  store: new ProjectionStore(),
  connect: async (want: ConnectTarget): Promise<RemoteConnection> => {
    const connection = await connectLive(want)
    const dispose = connection.dispose.bind(connection)
    return {
      rpc: connection.rpc,
      rehandshake: connection.rehandshake === undefined ? undefined : connection.rehandshake.bind(connection),
      dispose: async () => dispose(),
    }
  },
  ...(NEGATIVE ? { timers: deadTimers } : {}),
})

async function main(): Promise<void> {
  // 0. 清场：上一轮若是异常退出，远端可能还挂着监听，会让 A7-2 的「端口真的关了」失真。
  killRemoteOnPort(REMOTE_PORT)
  const cleaned = await waitUntil(() => !remotePortBusy(REMOTE_PORT), 30_000)
  record('A7-0', cleaned.ok, '远端 ' + String(REMOTE_PORT) + ' 端口清场' + (cleaned.ok ? '' : '（仍被占用）'), cleaned.ms)

  // 1. 基线：接入 + 投影在线。
  const attachedAt = Date.now()
  const attached = await service.attach(target, { remotePath: anchor.remotePath, localPath: anchor.localPath })
  const workspaceId = attached.workspace.id
  const baseline = service.snapshot()
  record(
    'A7-1',
    service.link === 'connected' &&
      baseline.workspaces.length === 1 &&
      baseline.workspaces[0]?.availability === 'online' &&
      workspaceId !== '',
    'link=' + service.link + ' / workspaces=' + String(baseline.workspaces.length) + ' / id=' + workspaceId,
    Date.now() - attachedAt,
  )

  // 2. 断线：杀远端 dsh → 下一次 RPC 必须被识别成传输层丢失，状态必须可见。
  const killed = killRemoteOnPort(REMOTE_PORT)
  const freed = await waitUntil(() => !remotePortBusy(REMOTE_PORT), 30_000)
  let code: string | null = null
  try {
    await service.createSession(workspaceId)
    code = '(未失败)'
  } catch (error) {
    code = error instanceof TeleportError ? error.code : String(error)
  }
  const afterKill = service.snapshot()
  const offlineAll = afterKill.workspaces.every((item) => item.availability === 'offline')
  record(
    'A7-2',
    freed.ok &&
      offlineAll &&
      service.link !== 'connected' &&
      (code === 'remote/tunnel-unavailable' || code === 'remote/disconnected'),
    'portFreed=' + String(freed.ok) + ' / code=' + String(code) + ' / link=' + service.link + ' / offline=' + String(offlineAll) +
      ' / entries=' + String(afterKill.workspaces.length) + ' / ' + killed,
    freed.ms,
  )

  // 3. 自动恢复：**不点任何按钮**，等自动退避把远端拉回来。
  const recovered = await waitUntil(() => service.link === 'connected', RECONNECT_BUDGET_MS)
  record(
    'A7-3',
    recovered.ok,
    'link=' + service.link + '（等 ' + String(recovered.ms) + 'ms，未做手动重连）',
    recovered.ms,
  )
  if (recovered.ok) {
    const listening = await waitUntil(() => remotePortBusy(REMOTE_PORT), 20_000)
    record('A7-3b', listening.ok, '远端 ' + String(REMOTE_PORT) + ' 重新监听', listening.ms)
  } else {
    record('A7-3b', false, '没连回来，端口自然不会监听')
  }

  // 4. 重连后投影要按远端重建：条目还在、id 不变、回到 online。
  // 必须**等**：`#attemptReconnect` 先设 `#live`（link 立刻变 connected），再逐条重放
  // `workspace/create`，重放完成后条目才回 online。A7-3 判的是「连上了」，A7-4 判的是
  // 「投影也回来了」，两者之间有一段可观测的延迟 —— 首跑就是在这里读早了（availability=offline）。
  const rebuiltAt = Date.now()
  const rebuiltOk = await waitUntil(() => {
    const snap = service.snapshot()
    return snap.workspaces.length === 1 && snap.workspaces[0]?.id === workspaceId && snap.workspaces[0]?.availability === 'online'
  }, 30_000)
  const rebuilt = service.snapshot()
  record(
    'A7-4',
    rebuiltOk.ok,
    'workspaces=' + String(rebuilt.workspaces.length) + ' / id 保持=' +
      String(rebuilt.workspaces[0]?.id === workspaceId) + ' / availability=' + String(rebuilt.workspaces[0]?.availability) +
      ' / 重建耗时=' + String(Date.now() - rebuiltAt) + 'ms',
  )

  // 5. 退出无孤儿：recycle 之后远端不再监听。
  service.recycle()
  const reaped = await waitUntil(() => !remotePortBusy(REMOTE_PORT), 30_000)
  record('A7-5', reaped.ok, '远端 ' + String(REMOTE_PORT) + ' 不再监听', reaped.ms)
}

try {
  await main()
} catch (error) {
  const failure = error instanceof TeleportError ? error.code + '：' + error.detail : String(error)
  record('A7-FATAL', false, failure)
} finally {
  try {
    service.recycle()
  } catch {
    /* 已经在 finally 里，不再让清理本身失败 */
  }
}

const failed = results.filter((item) => !item.ok).map((item) => item.name)
const passed = results.length - failed.length
console.log('')
console.log('结论：' + String(passed) + '/' + String(results.length) + ' 通过')
console.log('失败集：' + JSON.stringify(failed))

await mkdir(HERE, { recursive: true })
const file = join(HERE, NEGATIVE ? 'measurements.a7.neg.json' : 'measurements.a7.json')
await writeFile(file, JSON.stringify({ at: new Date().toISOString(), negative: NEGATIVE, alias: ALIAS, remotePort: REMOTE_PORT, results }, null, 2))
console.log('落盘：' + file)

if (NEGATIVE) {
  const same = JSON.stringify(failed.slice().sort()) === JSON.stringify([...NEG_EXPECTED_FAILURES].sort())
  console.log('负控失败集：' + JSON.stringify(failed) + ' 期望 ' + JSON.stringify(NEG_EXPECTED_FAILURES))
  console.log(same ? 'NEGATIVE CONTROL OK' : 'NEGATIVE CONTROL MISMATCH')
  process.exit(same ? 0 : 1)
} else {
  process.exit(failed.length === 0 ? 0 : 1)
}
