/**
 * M2 出口 A4：环境档位（`reuse` / `isolated`）真的作用到了远端 dsh 进程上。
 *
 * 为什么不能只测 `planEnv`：决策函数早就单测过了，它回答「该用哪个 DSH_HOME」；
 * 真正会错的是**从决策到进程**这一段 —— 档位选了隔离、启动命令里却没带 `DSH_HOME`，
 * 产品会照样连上、照样能跑，只是悄悄用了远端的 `~/.dsh`。这种失败不报错，只能靠证据抓：
 * 读远端那个 dsh 进程自己的 `/proc/<pid>/environ`。它说的是进程**实际**拿到的环境，
 * 不是我们以为自己传了什么。
 *
 * 顺带证明「状态可见」：快照里的 `envPolicy` 必须是这次连接用的档位，面板据此显示一行。
 *
 * 跑法：`MSYS_NO_PATHCONV=1 node spikes/m2/ssh-e2e/env-policy.ts [alias] [remoteRoot]`
 * 负控：`NEGATIVE_CONTROL=1`（隔离那一档拨回 reuse，期望 A4-4..A4-7 全红）。
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

import { createLiveConnect } from '../../../src/local/projection/live.ts'
import { ProjectionService } from '../../../src/local/projection/service.ts'
import { ProjectionStore } from '../../../src/local/projection/store.ts'
import { resolveAnchorPath } from '../../../src/local/backend/ssh/anchor-runtime.ts'
import { readSshConfig, resolveSshTarget } from '../../../src/local/backend/ssh/config.ts'
import type { ConnectTarget, RemoteConnection } from '../../../src/local/projection/service.ts'

const ALIAS = process.argv[2] ?? 'gcp'
const RAW_ROOT = process.argv[3] ?? 'home/hui/workspace'
const REMOTE_ROOT = RAW_ROOT.startsWith('/') ? RAW_ROOT : '/' + RAW_ROOT
const HOME_DIR = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
const REMOTE_PORT = Number(process.env['REMOTE_PORT'] ?? '8967')
/** 隔离档的远端目录（相对远端 home）；`hostKey` 与 `live.ts` 里的 `'ssh:' + alias` 一致。 */
const ISOLATED_TAIL = '.dsh-remote-cr/ssh:' + ALIAS
/** 负控：把隔离那一档拨回 `reuse`。期望变红的正是「隔离真的生效」那四条。 */
const NEGATIVE = process.env['NEGATIVE_CONTROL'] === '1'

interface Measurement { readonly name: string; readonly ok: boolean; readonly detail: string }
const results: Measurement[] = []
function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail })
  console.log((ok ? '  ok   ' : '  FAIL ') + name + ' — ' + detail)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function sshRun(command: string, timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn('ssh', ['-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', ALIAS, command], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const timer = setTimeout(() => { child.kill() }, timeoutMs)
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }) })
  })
}

/**
 * 监听 `REMOTE_PORT` 的那个远端进程的 pid。
 *
 * 不能用 `pgrep -f dsh`：执行这条命令的 shell 自己就带着那串特征，恒为 1 条（S9 踩过）。
 * 端口才是唯一不会自我命中的判据。
 */
async function remotePidOnPort(): Promise<number> {
  const listing = await sshRun('(command -v ss >/dev/null 2>&1 && ss -ltnp) || netstat -ltnp') 
  for (const line of listing.stdout.split('\n')) {
    if (!line.includes(':' + String(REMOTE_PORT))) continue
    const match = /pid=(\d+)/.exec(line)
    if (match !== null) return Number(match[1])
  }
  return 0
}

/** 远端进程**实际**拿到的环境（不是我们以为传了的）。 */
async function remoteEnv(pid: number): Promise<Map<string, string>> {
  const out = await sshRun("tr '\\0' '\\n' < /proc/" + String(pid) + '/environ')
  const env = new Map<string, string>()
  for (const line of out.stdout.split('\n')) {
    const at = line.indexOf('=')
    if (at <= 0) continue
    env.set(line.slice(0, at), line.slice(at + 1))
  }
  return env
}

/** 等远端端口释放：上一条连接是 `void handle.dispose()`（fire-and-forget），不等会撞端口。 */
async function waitPortFree(timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await remotePidOnPort()) === 0) return true
    await sleep(500)
  }
  return false
}

interface Leg { readonly conn: RemoteConnection; readonly env: Map<string, string>; readonly pid: number }

async function runLeg(policy: string, target: ConnectTarget): Promise<Leg> {
  const connect = createLiveConnect({
    launchTimeoutMs: 180_000,
    ssh: { homeDir: HOME_DIR, authFor: async () => ({ kind: 'key' as const }) },
    envPolicy: policy,
  })
  const conn = await connect(target)
  const deadline = Date.now() + 30_000
  let pid = 0
  while (pid === 0 && Date.now() < deadline) {
    pid = await remotePidOnPort()
    if (pid === 0) await sleep(400)
  }
  const env = pid === 0 ? new Map<string, string>() : await remoteEnv(pid)
  return { conn, env, pid }
}

const hostname = await sshRun('hostname')
record('A4-0 ssh 通道可用（拿得到远端主机名）', hostname.stdout.trim() !== '', hostname.stdout.trim())
const remoteHome = (await sshRun('printf %s "$HOME"')).stdout.trim()
const isolatedDir = remoteHome + '/' + ISOLATED_TAIL

// 先把隔离目录清掉：不清的话「隔离目录在远端落地」可能是上一次跑留下的，断言就空了。
if (isolatedDir.includes('.dsh-remote-cr/')) await sshRun('rm -rf ' + JSON.stringify(isolatedDir))

const target: ConnectTarget = { backend: 'ssh', alias: ALIAS, port: REMOTE_PORT, remoteRoot: REMOTE_ROOT }

// ── reuse 档 ──────────────────────────────────────────────────────────────
const reuse = await runLeg('reuse', target)
record('A4-1 reuse 档连上了，且连接对象报的档位就是 reuse', reuse.conn.envPolicy === 'reuse', 'pid=' + String(reuse.pid) + ' envPolicy=' + String(reuse.conn.envPolicy))
record(
  'A4-2 reuse 档：远端 dsh 进程环境里没有 DSH_HOME（用的是远端自己的 ~/.dsh）',
  reuse.pid > 0 && !reuse.env.has('DSH_HOME'),
  'pid=' + String(reuse.pid) + ' DSH_HOME=' + String(reuse.env.get('DSH_HOME') ?? '<无>') + ' 变量数=' + String(reuse.env.size),
)
const reuseIsolated = await sshRun('test -d ' + JSON.stringify(isolatedDir) + ' && echo yes || echo no')
record('A4-3 reuse 档没有顺手建隔离目录（不越界）', reuseIsolated.stdout.trim() === 'no', isolatedDir)
reuse.conn.dispose()
const freedAfterReuse = await waitPortFree()
record('A4-3b 上一条连接收尾后远端端口释放（否则下一档会撞端口）', freedAfterReuse, 'port=' + String(REMOTE_PORT))

// ── isolated 档 ───────────────────────────────────────────────────────────
const requested = NEGATIVE ? 'reuse' : 'isolated'
const isolated = await runLeg(requested, target)
record(
  'A4-4 isolated 档连上了，且连接对象报的档位就是 isolated',
  isolated.conn.envPolicy === 'isolated',
  'requested=' + requested + ' envPolicy=' + String(isolated.conn.envPolicy),
)
record(
  'A4-5 isolated 档：远端 dsh 进程环境里 DSH_HOME 正是隔离目录',
  isolated.env.get('DSH_HOME') === isolatedDir,
  'DSH_HOME=' + String(isolated.env.get('DSH_HOME') ?? '<无>') + ' 期望=' + isolatedDir,
)
const landed = await sshRun('test -d ' + JSON.stringify(isolatedDir) + ' && echo yes || echo no')
record('A4-6 isolated 档的目录在远端真的建出来了', landed.stdout.trim() === 'yes', isolatedDir)

// ── 状态可见：快照里报的就是这次连接的档位 ────────────────────────────────
const config = readSshConfig({ homeDir: HOME_DIR, file: HOME_DIR + '/.ssh/config' })
const resolved = resolveSshTarget(config.parsed, ALIAS, { homeDir: HOME_DIR })
if (resolved.target === undefined) throw new Error('ssh config 里没有别名 ' + ALIAS)
const anchor = await resolveAnchorPath({ homeDir: HOME_DIR, target: resolved.target, remotePath: REMOTE_ROOT })
const service = new ProjectionService({ store: new ProjectionStore(), connect: async () => isolated.conn })
await service.attach(target, { remotePath: REMOTE_ROOT, localPath: anchor.localPath })
const snapshot = service.snapshot()
record(
  'A4-7 面板能看到的快照里带了这次连接的档位（隔离不会被悄悄改回复用）',
  snapshot.envPolicy === 'isolated' && snapshot.connected,
  'snapshot.envPolicy=' + String(snapshot.envPolicy) + ' connected=' + String(snapshot.connected),
)

// ── 写错的档位必须给出结构化错误，不许静默回落 ───────────────────────────
/** 用 WSL 目标试：`connectWsl` 在起进程**之前**就解析档位，写错时立刻抛。 */
const wslTarget: ConnectTarget = { backend: 'wsl', distro: 'ubuntu_dev', port: 8899, remoteRoot: '/tmp' }
async function policyError(policy: string): Promise<string> {
  const connect = createLiveConnect({ ssh: { homeDir: HOME_DIR, authFor: async () => ({ kind: 'key' as const }) }, envPolicy: policy })
  try {
    await connect(wslTarget)
    return '<没有抛错>'
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : '<无错误码: ' + String(error) + '>'
  }
}
const bogus = await policyError('bogus')
record('A4-8 写错的档位给出 remote/env-policy-invalid（不静默按 reuse 跑）', bogus === 'remote/env-policy-invalid', bogus)
const sync = await policyError('sync')
record('A4-9 sync 档明确拒绝：remote/env-policy-unavailable（M3 才落地）', sync === 'remote/env-policy-unavailable', sync)

service.dispose()
const freedFinal = await waitPortFree()
console.log('  info 收尾端口释放=' + String(freedFinal))

const failed = results.filter((item) => !item.ok)
console.log('')
console.log(String(results.length - failed.length) + '/' + String(results.length) + ' passed')
if (!NEGATIVE) {
  writeFileSync(new URL('./measurements.env.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), alias: ALIAS, remoteRoot: REMOTE_ROOT, isolatedDir, results }, null, 2) + '\n')
}
if (NEGATIVE) {
  // 负控判据是**失败集恰好等于期望集**：多红一条说明断言互相串了，少红一条说明有一条是空的。
  const expected = ['A4-4', 'A4-5', 'A4-6', 'A4-7']
  const actual = failed.map((item) => item.name.split(' ')[0]).sort()
  const same = JSON.stringify(actual) === JSON.stringify([...expected].sort())
  console.log('failed=' + JSON.stringify(actual) + ' expected=' + JSON.stringify([...expected].sort()))
  console.log(same ? 'NEGATIVE CONTROL OK' : 'NEGATIVE CONTROL MISMATCH')
  process.exit(same ? 0 : 1)
}
process.exit(failed.length === 0 ? 0 : 1)
