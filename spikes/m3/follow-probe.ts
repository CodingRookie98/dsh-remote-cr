/** 诊断：打印 workspace/follow 的首帧（确认 baseline 的真实形状）。用完即弃。 */
import { join } from 'node:path'

import { resolveAnchorPath } from '../../src/local/backend/ssh/anchor-runtime.ts'
import { readSshConfig, resolveSshTarget } from '../../src/local/backend/ssh/config.ts'
import { createLiveConnect } from '../../src/local/projection/live.ts'
import { ProjectionService, type ConnectTarget } from '../../src/local/projection/service.ts'
import { ProjectionStore } from '../../src/local/projection/store.ts'
import { defaultTimers } from '../../src/shared/reconnect.ts'

const HOME = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
const PORT = Number(process.env['REMOTE_PORT'] ?? '8951')
const cfg = join(HOME, '.ssh', 'config')
const config = readSshConfig({ file: cfg, homeDir: HOME })
const resolved = resolveSshTarget(config.parsed, 'gcp', { homeDir: HOME, file: cfg })
if (resolved.target === undefined) process.exit(2)
const anchor = await resolveAnchorPath({ homeDir: HOME, target: resolved.target, remotePath: '/home/hui/workspace' })
const target: ConnectTarget = { backend: 'ssh', alias: 'gcp', port: PORT, remoteRoot: anchor.remotePath }
const live = createLiveConnect({ ssh: { homeDir: HOME, authFor: async () => ({ kind: 'key' as const }) } })
const service = new ProjectionService({ store: new ProjectionStore(), timers: defaultTimers, connect: async (w: ConnectTarget) => live(w) })
await service.attach(target, { remotePath: anchor.remotePath, localPath: anchor.localPath })

// 走内部字段拿 rpc：诊断脚本可以直接读私有（不参与构建）
const rpc = (service as unknown as { liveConnection?: { rpc: unknown } })
const connection = (service as unknown as { 'live': unknown })
console.log('service attached; 用 importable 的同一路径读流')
const rows = await service.importable()
console.log('importable rows=' + JSON.stringify(rows))
try {
  const result = await service.importWorkspaces(rows.map((item) => item.path))
  console.log('imported=' + JSON.stringify(result) + ' projected=' + String(service.snapshot().workspaces.length))
} catch (error) {
  console.log('IMPORT FAILED: ' + JSON.stringify({ code: (error as { code?: string }).code, detail: (error as { detail?: string }).detail }))
}
service.recycle()
process.exit(0)
