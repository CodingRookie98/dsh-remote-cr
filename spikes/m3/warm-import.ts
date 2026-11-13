/**
 * 预热：在远端**再建一个**工作区，供 M4-1 的导入正例使用。
 *
 * 为什么需要它：workspace/create 在远端幂等，而唯一能触发它的产品路径就是「接入」。
 * 导入正例要求「远端有、本地没投影」，所以先单独接入一次把远端那份建出来，再退出
 * （投影只活在进程内存里，退出即清空）。
 *
 * 用法：node spikes/m3/warm-import.ts [alias] [remotePath]
 */
import { join } from 'node:path'

import { resolveAnchorPath } from '../../src/local/backend/ssh/anchor-runtime.ts'
import { readSshConfig, resolveSshTarget } from '../../src/local/backend/ssh/config.ts'
import { createLiveConnect } from '../../src/local/projection/live.ts'
import { ProjectionService, type ConnectTarget } from '../../src/local/projection/service.ts'
import { ProjectionStore } from '../../src/local/projection/store.ts'
import { defaultTimers } from '../../src/shared/reconnect.ts'

const ALIAS = process.argv[2] ?? 'gcp'
// 只用 env：MSYS 会把 argv 里的 `/home/...` 转成 `C:/Users/...`（实测过），env 不会。
const REMOTE_PATH = process.env['REMOTE_PATH'] ?? '/home/hui/workspace-import'
const PORT = Number(process.env['REMOTE_PORT'] ?? '8950')
const HOME = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
const cfg = join(HOME, '.ssh', 'config')
const config = readSshConfig({ file: cfg, homeDir: HOME })
const resolved = resolveSshTarget(config.parsed, ALIAS, { homeDir: HOME, file: cfg })
if (resolved.target === undefined) {
  console.error('没有别名 ' + ALIAS)
  process.exit(2)
}
const anchor = await resolveAnchorPath({ homeDir: HOME, target: resolved.target, remotePath: REMOTE_PATH })
const target: ConnectTarget = { backend: 'ssh', alias: ALIAS, port: PORT, remoteRoot: REMOTE_PATH }
const live = createLiveConnect({ ssh: { homeDir: HOME, authFor: async () => ({ kind: 'key' as const }) } })
const service = new ProjectionService({
  store: new ProjectionStore(),
  timers: defaultTimers,
  connect: async (want: ConnectTarget) => live(want),
})
const attached = await service.attach(target, { remotePath: anchor.remotePath, localPath: anchor.localPath })
console.log(JSON.stringify({ workspaceId: attached.workspace.id, remotePath: anchor.remotePath }))
service.recycle()
process.exit(0)
