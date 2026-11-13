/** 造样本：一次 attach 之后连调 N 次 workspace/create，用于验证导入列表在多条目下的表现。 */
import { join } from 'node:path'

import { resolveAnchorPath } from '../../src/local/backend/ssh/anchor-runtime.ts'
import { readSshConfig, resolveSshTarget } from '../../src/local/backend/ssh/config.ts'
import { createLiveConnect } from '../../src/local/projection/live.ts'
import type { ConnectTarget } from '../../src/local/projection/service.ts'

const COUNT = Number(process.env['SEED_COUNT'] ?? '20')
const HOME = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
const PORT = Number(process.env['REMOTE_PORT'] ?? '8953')
const cfg = join(HOME, '.ssh', 'config')
const config = readSshConfig({ file: cfg, homeDir: HOME })
const resolved = resolveSshTarget(config.parsed, 'gcp', { homeDir: HOME, file: cfg })
if (resolved.target === undefined) process.exit(2)
const anchor = await resolveAnchorPath({ homeDir: HOME, target: resolved.target, remotePath: '/home/hui/workspace' })
const target: ConnectTarget = { backend: 'ssh', alias: 'gcp', port: PORT, remoteRoot: anchor.remotePath }
const live = createLiveConnect({ ssh: { homeDir: HOME, authFor: async () => ({ kind: 'key' as const }) } })
const connection = await live(target)
let created = 0
for (let index = 0; index < COUNT; index += 1) {
  const path = '/home/hui/seed-' + String(index)
  await connection.rpc.call('workspace/create', { args: { request: { path } } })
  created += 1
}
console.log(JSON.stringify({ created }))
await connection.dispose()
process.exit(0)
