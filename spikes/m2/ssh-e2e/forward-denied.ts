/**
 * M2 出口门槛 2：服务端 `AllowTcpForwarding no` 时必须给**可操作**的失败提示。
 *
 * 为什么必须真机：判据来自 ssh 自己的一句话（`Error: remote port forwarding failed for listen port 0`），
 * 而这句话是否出现取决于 `ExitOnForwardFailure`、服务端 `AllowTcpForwarding`、以及 sshd 版本。
 * 单测只能证明正则匹配得上，证明不了「真的被拒时我们真的看得见这句话」。
 *
 * 夹具（**不动宿主既有 sshd**）：远端 `/tmp/teleport-nofwd/` 下起第二个 sshd，只监听远端回环
 * 12222，`AllowTcpForwarding no`，`AuthorizedKeysFile` 指向临时文件（里面放本机现有公钥）；
 * Windows 侧再开一条 `-L 12222:127.0.0.1:12222` 隧道。被测的产品客户端因此连到的是一个
 * **真的拒绝转发**的服务端。
 *
 * 两个踩过的坑（写在这里省下一次重跑）：
 * 1. `UsePAM no` 会因 `User hui not allowed because account is locked` 直接拒绝（这个账号密码位是 `!`），
 *    必须 `UsePAM yes` —— 宿主主 sshd 能放行也是这个原因；
 * 2. 用 `ssh gcp 'bash -s' < script` 跑远程脚本时，脚本里的 `ssh` 会**吃掉剩余的 stdin**，
 *    必须给内层 ssh `-n` 或 `< /dev/null`，否则后面的命令整段消失。
 *
 * 跑法：`node spikes/m2/ssh-e2e/forward-denied.ts [alias]`
 * 负控：`NEGATIVE_CONTROL=1` —— 夹具改成 `AllowTcpForwarding yes`，此时**不许**再出现
 * `remote/forward-unavailable`（否则说明分类器见谁都喊狼来了）。
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'

import { TeleportError } from '../../../src/local/backend/errors.ts'
import { type SshTarget, readSshConfig, resolveSshTarget } from '../../../src/local/backend/ssh/config.ts'
import { launchSshDsh } from '../../../src/local/backend/ssh/launch.ts'

const ALIAS = process.argv[2] ?? 'gcp'
const NEGATIVE = process.env['NEGATIVE_CONTROL'] === '1'
const HOME_DIR = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
const FIXTURE_PORT = Number(process.env['FIXTURE_PORT'] ?? '12222')
const DIR = '/tmp/teleport-nofwd'
const CONFIG_FILE = join(HOME_DIR, '.ssh', 'config')
const LOCAL_KEY = process.env['FIXTURE_KEY'] ?? join(HOME_DIR, '.ssh', 'id_ed25519')

interface Measurement { readonly name: string; readonly ok: boolean; readonly detail: string }
const results: Measurement[] = []
function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail })
  console.log((ok ? '  ok   ' : '  FAIL ') + name + ' — ' + detail)
}

async function sshRun(command: string, timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
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

async function waitPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => { socket.destroy(); resolve(false) })
    })
    if (ok) return true
    await new Promise<void>((resolve) => setTimeout(resolve, 250))
  }
  return false
}

const publicKey = (await readFile(LOCAL_KEY + '.pub', 'utf8')).trim()
const allow = NEGATIVE ? 'yes' : 'no'
const setup = [
  'set -u',
  'rm -rf ' + DIR + ' && mkdir -p ' + DIR + ' && chmod 700 ' + DIR,
  "printf '%s\\n' '" + publicKey + "' > " + DIR + '/authorized_keys',
  'chmod 600 ' + DIR + '/authorized_keys',
  'cat > ' + DIR + '/sshd_config <<\'CFG\'',
  'Port ' + String(FIXTURE_PORT),
  'ListenAddress 127.0.0.1',
  'HostKey /etc/ssh/ssh_host_ed25519_key',
  'HostKey /etc/ssh/ssh_host_rsa_key',
  'PidFile ' + DIR + '/sshd.pid',
  'PasswordAuthentication no',
  'KbdInteractiveAuthentication no',
  'PubkeyAuthentication yes',
  'AuthorizedKeysFile ' + DIR + '/authorized_keys',
  'StrictModes no',
  'UsePAM yes',
  'AllowTcpForwarding ' + allow,
  'AllowAgentForwarding no',
  'LogLevel VERBOSE',
  'CFG',
  'sudo /usr/sbin/sshd -f ' + DIR + '/sshd_config -E ' + DIR + '/sshd.log',
  'sleep 1',
  'cat ' + DIR + '/sshd.pid',
].join('\n')

const prepared = await sshRun(setup)
record('FW-0 夹具 sshd 起来了', prepared.code === 0, 'pid=' + prepared.stdout.trim() + ' stderr=' + prepared.stderr.trim().slice(0, 200))

const tunnel = spawn('ssh', [
  '-n', '-N',
  '-o', 'BatchMode=yes',
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ServerAliveInterval=15',
  '-L', '127.0.0.1:' + String(FIXTURE_PORT) + ':127.0.0.1:' + String(FIXTURE_PORT),
  ALIAS,
], { windowsHide: true })
const tunnelReady = await waitPort(FIXTURE_PORT, 20_000)
record('FW-1 本地隧道口可连', tunnelReady, 'port=' + String(FIXTURE_PORT))

const base = resolveSshTarget(readSshConfig({ file: CONFIG_FILE, homeDir: HOME_DIR }).parsed, ALIAS, { homeDir: HOME_DIR, file: CONFIG_FILE })
const target: SshTarget = {
  alias: 'forward-denied-fixture',
  hostName: '127.0.0.1',
  user: base.target?.user ?? 'hui',
  port: FIXTURE_PORT,
  identityFiles: [LOCAL_KEY],
  proxyJump: [],
  source: { file: CONFIG_FILE, line: 0 },
}

let code: string | undefined
let detail = ''
let actions: readonly string[] = []
let handle: Awaited<ReturnType<typeof launchSshDsh>> | undefined
const started = Date.now()
try {
  handle = await launchSshDsh({
    homeDir: HOME_DIR,
    target,
    auth: { kind: 'key' },
    remoteRoot: '/tmp',
    remotePort: 8899,
    proxyPort: 45_678,
    timeoutMs: 25_000,
    connectTimeoutMs: 10_000,
  })
  code = 'ok'
} catch (error) {
  if (error instanceof TeleportError) {
    code = error.code
    detail = error.detail
    actions = error.nextActions
  } else {
    code = 'non-teleport-error'
    detail = error instanceof Error ? error.message : String(error)
  }
} finally {
  if (handle !== undefined) await handle.dispose()
  tunnel.kill()
  const cleaned = await sshRun('sudo kill $(cat ' + DIR + '/sshd.pid) 2>/dev/null || true; rm -rf ' + DIR)
  if (cleaned.code !== 0) console.log('  warn  夹具清理返回 ' + String(cleaned.code) + '：' + cleaned.stderr.slice(0, 120))
}
const elapsed = Date.now() - started

if (NEGATIVE) {
  record(
    'FW-2 负控：放行转发的服务端上不许报 remote/forward-unavailable',
    code !== 'remote/forward-unavailable',
    'code=' + String(code) + ' (' + String(elapsed) + 'ms)',
  )
} else {
  record('FW-2 报的是 remote/forward-unavailable', code === 'remote/forward-unavailable', 'code=' + String(code) + ' (' + String(elapsed) + 'ms) detail=' + detail.slice(0, 140))
  record('FW-3 提示可操作（≥2 条 nextActions）', actions.length >= 2, JSON.stringify(actions))
  record('FW-4 提示点名 AllowTcpForwarding', detail.includes('AllowTcpForwarding') || actions.some((item) => item.includes('AllowTcpForwarding')), detail.slice(0, 160))
}

const failed = results.filter((item) => !item.ok)
console.log('')
console.log(String(results.length - failed.length) + '/' + String(results.length) + ' passed' + (NEGATIVE ? ' (negative control)' : ''))
process.exit(failed.length === 0 ? 0 : 1)