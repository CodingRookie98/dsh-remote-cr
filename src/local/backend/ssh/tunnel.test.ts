/**
 * `openSshTunnel`（attach-only）的行为契约。
 *
 * 判据是「本地端口可连」，不是「ssh 进程还活着」：ssh 可能在、隧道却没建起来。
 * 这两条测试把两种形态都钉住 —— 失败必须抛 `remote/tunnel-unavailable`（让上层回落到
 * 正常启动），成功必须返回可用句柄。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:net'
import test from 'node:test'

import type { SshTarget } from './config.ts'
import { openSshTunnel, type SshLaunchSpawn } from './launch.ts'

const TARGET: SshTarget = {
  alias: 'gcp',
  hostName: '10.0.0.9',
  user: 'hui',
  port: 22,
  identityFiles: ['C:/Users/hui/.ssh/id_ed25519'],
  proxyJump: [],
  source: { file: 'C:/Users/hui/.ssh/config', line: 1 },
}

const fakeSpawn = (): SshLaunchSpawn => () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { write: () => true, end: () => undefined },
    kill: () => true,
  })
  return child as never
}

test('隧道建不起来时抛 remote/tunnel-unavailable（上层据此回落到正常启动）', async () => {
  await assert.rejects(
    openSshTunnel({
      homeDir: 'C:/Users/hui',
      target: TARGET,
      auth: { kind: 'key' },
      remotePort: 65_000,
      localPort: 65_001,
      readyTimeoutMs: 80,
      spawn: fakeSpawn(),
    }),
    (error: unknown) => (error as { code?: string }).code === 'remote/tunnel-unavailable',
  )
})

test('本地端口可连时返回句柄，dispose 只关隧道', async () => {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  try {
    const tunnel = await openSshTunnel({
      homeDir: 'C:/Users/hui',
      target: TARGET,
      auth: { kind: 'key' },
      remotePort: 65_002,
      localPort: port,
      readyTimeoutMs: 500,
      spawn: fakeSpawn(),
    })
    assert.equal(tunnel.localPort, port)
    assert.equal(tunnel.remotePort, 65_002)
    assert.equal(await tunnel.dispose(), true)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
