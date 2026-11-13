/** 诊断脚本：驻留实例的「接回」路径逐步取证。用完即弃，不进产品。 */
import { spawnSync } from 'node:child_process'
import { resolveAnchorPath } from '../../src/local/backend/ssh/anchor-runtime.ts'
import { anchorIdFor, anchorTargetOf } from '../../src/local/backend/ssh/anchors.ts'
import { readSshConfig, resolveSshTarget } from '../../src/local/backend/ssh/config.ts'
import { buildReadInstanceScript, instancePath, isInstanceExpired, parseInstanceOutput } from '../../src/local/backend/ssh/instance.ts'
import { knownHostsPath } from '../../src/local/backend/ssh/known-hosts.ts'
import { openSshTunnel } from '../../src/local/backend/ssh/launch.ts'
import { runSsh } from '../../src/local/backend/ssh/transport.ts'
import { shellQuote } from '../../src/local/backend/posix-probe.ts'
import { createLiveConnect } from '../../src/local/projection/live.ts'
import { RemoteRpc } from '../../src/local/projection/remote.ts'
import { ProjectionService, type ConnectTarget } from '../../src/local/projection/service.ts'
import { ProjectionStore } from '../../src/local/projection/store.ts'
import { defaultTimers } from '../../src/shared/reconnect.ts'

const HOME = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
const PORT = Number(process.env['REMOTE_PORT'] ?? '8947')
const ALIAS = 'gcp'
const cfg = HOME + '/.ssh/config'
const config = readSshConfig({ file: cfg, homeDir: HOME })
const resolved = resolveSshTarget(config.parsed, ALIAS, { homeDir: HOME, file: cfg })
if (resolved.target === undefined) { console.error('no alias'); process.exit(2) }
const target = resolved.target
const auth = { kind: 'key' as const }
const anchor = await resolveAnchorPath({ homeDir: HOME, target, remotePath: '/home/hui/workspace' })
const connectTarget: ConnectTarget = { backend: 'ssh', alias: ALIAS, port: PORT, remoteRoot: anchor.remotePath }
const live = createLiveConnect({ ssh: { homeDir: HOME, authFor: async () => auth } })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const service = new ProjectionService({
  store: new ProjectionStore(),
  timers: defaultTimers,
  keepRemote: true,
  connect: async (want: ConnectTarget) => live(want),
})
console.log('STEP 1 attach ...')
const attached = await service.attach(connectTarget, { remotePath: anchor.remotePath, localPath: anchor.localPath })
console.log('attached workspace=' + attached.workspace.id)
service.dispose()
console.log('disposed (keepRemote)')
await sleep(8_000)

const remoteHome = await service.remoteHomeProbe?.() ?? null
console.log('STEP 2 read instance ...')
const anchorId = anchorIdFor(anchorTargetOf(target))
const file = instancePath('/home/hui', anchorId)
const read = await runSsh({
  target,
  knownHostsFile: knownHostsPath(HOME),
  auth,
  command: ['sh', '-c', shellQuote(buildReadInstanceScript(file, PORT))],
  allowFailure: true,
  deadlineMs: 15_000,
})
console.log('raw stdout: ' + JSON.stringify(read.stdout.slice(0, 400)))
const parsed = parseInstanceOutput(read.stdout, PORT)
console.log('parsed: ' + JSON.stringify(parsed))
console.log('expired: ' + String(parsed === null ? 'n/a' : isInstanceExpired(parsed.instance, Date.now())))
if (parsed !== null && parsed.portListening) {
  console.log('STEP 3 openSshTunnel ...')
  try {
    const tunnel = await openSshTunnel({ homeDir: HOME, target, auth, remotePort: PORT })
    console.log('tunnel localPort=' + String(tunnel.localPort))
    console.log('STEP 4 handshake ...')
    const rpc = await RemoteRpc.open({ host: '127.0.0.1', port: tunnel.localPort }, parsed.instance.token, {})
    console.log('handshake OK')
    const snap = await rpc.call('session/list', { args: { _request: {} } })
    console.log('session/list OK items=' + String((snap as { items?: unknown[] }).items?.length ?? 'n/a'))
    rpc.dispose()
    await tunnel.dispose()
  } catch (error) {
    const failure = error as { code?: string; detail?: string; logTail?: string }
    console.log('FAILED: ' + JSON.stringify({ code: failure.code, detail: failure.detail, logTail: (failure.logTail ?? '').slice(-600) }))
  }
}
const cleanup = spawnSync('ssh', ['-n', '-o', 'BatchMode=yes', ALIAS, 'pids=$(ss -ltnp 2>/dev/null | grep ":' + String(PORT) + ' " | grep -oE "pid=[0-9]+" | cut -d= -f2 | sort -u); for p in $pids; do kill -9 $p 2>/dev/null; done; rm -f ~/.dsh-teleport/instances/*.json; echo cleaned'], { encoding: 'utf8', timeout: 30000 })
console.log('cleanup: ' + cleanup.stdout.trim())
process.exit(0)
