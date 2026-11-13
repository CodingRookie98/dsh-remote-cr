/** 清理：删掉 seed-workspaces.ts 造出来的样本（workspace/delete）。 */
import { join } from 'node:path'

import { resolveAnchorPath } from '../../src/local/backend/ssh/anchor-runtime.ts'
import { readSshConfig, resolveSshTarget } from '../../src/local/backend/ssh/config.ts'
import { createLiveConnect } from '../../src/local/projection/live.ts'
import type { ConnectTarget } from '../../src/local/projection/service.ts'

const HOME = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
const PORT = Number(process.env['REMOTE_PORT'] ?? '8954')
const cfg = join(HOME, '.ssh', 'config')
const config = readSshConfig({ file: cfg, homeDir: HOME })
const resolved = resolveSshTarget(config.parsed, 'gcp', { homeDir: HOME, file: cfg })
if (resolved.target === undefined) process.exit(2)
const anchor = await resolveAnchorPath({ homeDir: HOME, target: resolved.target, remotePath: '/home/hui/workspace' })
const target: ConnectTarget = { backend: 'ssh', alias: 'gcp', port: PORT, remoteRoot: anchor.remotePath }
const live = createLiveConnect({ ssh: { homeDir: HOME, authFor: async () => ({ kind: 'key' as const }) } })
const connection = await live(target)

const stream = connection.rpc.openStream('workspace/follow', { args: {} })
const first = await stream[Symbol.asyncIterator]().next()
stream.cancel()
const frame = (first.done === true ? undefined : first.value) as { type?: string; value?: unknown } | undefined
const inner = (frame?.type === 'item' ? frame.value : frame) as { type?: string; value?: { items?: unknown[] } } | undefined
const items = inner?.value?.items ?? []
let removed = 0
for (const item of items) {
  const view = item as { workspaceId?: string; path?: string }
  if (view.workspaceId === undefined || view.path === undefined) continue
  if (!view.path.includes('/seed-')) continue
  await connection.rpc.call('workspace/delete', { args: { request: { workspaceId: view.workspaceId } } })
  removed += 1
}
console.log(JSON.stringify({ removed, remaining: items.length - removed }))
await connection.dispose()
process.exit(0)
