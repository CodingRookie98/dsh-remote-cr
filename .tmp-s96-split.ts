import { join } from 'node:path'
import { readSshConfig, resolveSshTarget } from './src/local/backend/ssh/config.ts'
import { resolveAnchorPath } from './src/local/backend/ssh/anchor-runtime.ts'
import { ProjectionService, type ConnectTarget } from './src/local/projection/service.ts'
import { ProjectionStore } from './src/local/projection/store.ts'
import { createLiveConnect } from './src/local/projection/live.ts'

const HOME_DIR = process.env['USERPROFILE'] ?? ''
const file = join(HOME_DIR, '.ssh', 'config')
const sshTarget = resolveSshTarget(readSshConfig({ file, homeDir: HOME_DIR }).parsed, 'gcp', { homeDir: HOME_DIR, file }).target!
const anchor = await resolveAnchorPath({ homeDir: HOME_DIR, target: sshTarget, remotePath: '/home/hui/workspace' })
const target: ConnectTarget = { backend: 'ssh', alias: 'gcp', port: Number(process.env['RPORT'] ?? '8937'), remoteRoot: anchor.remotePath }
const service = new ProjectionService({ store: new ProjectionStore(), connect: createLiveConnect({ ssh: { homeDir: HOME_DIR, authFor: async () => ({ kind: 'key' as const }) } }) })

let t = Date.now()
const first = await service.attach(target, { remotePath: anchor.remotePath, localPath: anchor.localPath })
console.log('attach#1 (cold: connect + workspace):', Date.now() - t, 'ms')

t = Date.now()
await service.attach(target, { remotePath: anchor.remotePath, localPath: anchor.localPath })
console.log('attach#2 (open workspace on live conn):', Date.now() - t, 'ms')

for (const warmupMs of [0, 600, 1200, 2000]) {
  const created = await service.createSession(first.workspace.id)
  t = Date.now()
  const probed = await service.probe(created.sessionId, { warmupMs })
  console.log('probe warmup=' + String(warmupMs) + ':', Date.now() - t, 'ms |', probed.cwd)
}

service.disconnect()
t = Date.now()
await service.reconnectNow()
console.log('manual reconnect (rehandshake path):', Date.now() - t, 'ms')
service.recycle()