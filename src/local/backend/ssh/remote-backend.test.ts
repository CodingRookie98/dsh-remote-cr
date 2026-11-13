import assert from 'node:assert/strict'
import test from 'node:test'

import { TeleportError } from '../errors.ts'
import type { RemoteDshHandle } from '../handle.ts'
import type { SshTarget } from './config.ts'
import { SshRemoteBackend, type ProbeLike, type SshLaunchLike } from './remote-backend.ts'
import type { SshProbeResult } from './probe.ts'
import type { SshRemoteHandle } from './launch.ts'
import type { SshAuth } from './transport.ts'

const TARGET: SshTarget = {
  alias: 'gcp',
  hostName: '203.0.113.10',
  user: 'hui',
  port: 22,
  identityFiles: ['/home/hui/.ssh/id_ed25519'],
  proxyJump: [],
  source: { file: '/home/hui/.ssh/config', line: 3 },
}

const AUTH: SshAuth = { kind: 'key' }

function probeResult(): SshProbeResult {
  return {
    probe: {
      kind: 'ssh',
      target: 'hui@203.0.113.10',
      home: '/home/hui',
      nodeVersion: 'v24.22.1',
      dshVersion: undefined,
      hasDshHome: true,
      mirroredNetwork: undefined,
    },
    system: { platform: 'Linux', arch: 'x86_64', kernel: '6.8.0' },
    parsed: { values: {}, missing: [], conflicts: [], complete: true },
    connect: {} as SshProbeResult['connect'],
  }
}

function handle(clean: boolean): SshRemoteHandle & { disposed: number } {
  const h = {
    disposed: 0,
    localPort: 51234,
    remotePort: 8899,
    remoteProxyPort: undefined,
    endpoint: { host: '127.0.0.1', port: 51234, token: 't' },
    log: () => '',
    dispose: async () => {
      h.disposed += 1
      return clean
    },
    keepAlive: async () => {
      // 驻留模式：不回收，什么都不做。
    },
    remotePid: null,
  }
  return h
}

test('target 用配置里的别名（用户在配置里认得出的那个）', () => {
  const backend = new SshRemoteBackend({ homeDir: '/home/hui', target: TARGET, auth: AUTH })
  assert.equal(backend.kind, 'ssh')
  assert.equal(backend.target, 'gcp')
})

test('probe 把连接参数原样交给探测函数，并直接返回它的 probe', async () => {
  const seen: unknown[] = []
  const probe: ProbeLike = async (request) => {
    seen.push(request)
    return probeResult()
  }
  const backend = new SshRemoteBackend({
    homeDir: '/home/hui',
    target: TARGET,
    auth: AUTH,
    sshExecutable: 'ssh.exe',
    probeTimeoutMs: 1234,
    probe,
    launch: async () => handle(true),
  })

  const result = await backend.probe()

  assert.equal(result.target, 'hui@203.0.113.10')
  assert.equal(result.kind, 'ssh')
  const request = seen[0] as Record<string, unknown>
  assert.equal(request['homeDir'], '/home/hui')
  assert.equal(request['target'], TARGET)
  assert.equal(request['auth'], AUTH)
  assert.equal(request['sshExecutable'], 'ssh.exe')
  assert.equal(request['deadlineMs'], 1234)
})

test('探测抛 TeleportError 时原样上抛（相别由 errors.ts 分，不在这里改写）', async () => {
  const original = new TeleportError({
    code: 'remote/host-key-mismatch',
    detail: '指纹变了',
    nextActions: ['核对指纹'],
  })
  const backend = new SshRemoteBackend({
    homeDir: '/h',
    target: TARGET,
    auth: AUTH,
    probe: async () => {
      throw original
    },
    launch: async () => handle(true),
  })

  await assert.rejects(backend.probe(), (error: unknown) => {
    assert.equal(error, original)
    return true
  })
})

test('探测抛裸 Error 时包成 remote/probe-incomplete，保留原文', async () => {
  const backend = new SshRemoteBackend({
    homeDir: '/h',
    target: TARGET,
    auth: AUTH,
    probe: async () => {
      throw new Error('spawn ssh ENOENT')
    },
    launch: async () => handle(true),
  })

  await assert.rejects(backend.probe(), (error: unknown) => {
    assert.ok(error instanceof TeleportError)
    assert.equal(error.code, 'remote/probe-incomplete')
    assert.match(error.detail, /spawn ssh ENOENT/)
    assert.match(error.detail, /gcp/)
    return true
  })
})

test('launch 把 LaunchRequest 合进 SshLaunchOptions，不丢连接参数', async () => {
  const seen: unknown[] = []
  const launch: SshLaunchLike = async (options) => {
    seen.push(options)
    return handle(true)
  }
  const backend = new SshRemoteBackend({
    homeDir: '/home/hui',
    target: TARGET,
    auth: AUTH,
    remotePort: 8899,
    proxyPort: 8900,
    launch,
  })

  const launched = await backend.launch({ port: 8899, remoteRoot: '/home/hui/dsh' })

  assert.equal((launched as SshRemoteHandle).localPort, 51234)
  const options = seen[0] as Record<string, unknown>
  assert.equal(options['homeDir'], '/home/hui')
  assert.equal(options['target'], TARGET)
  assert.equal(options['auth'], AUTH)
  assert.equal(options['remoteRoot'], '/home/hui/dsh')
  assert.equal(options['remotePort'], 8899)
  assert.equal(options['proxyPort'], 8900)
  // 没给 localPort 就不写这个键，交给内核挑端口。
  assert.equal('localPort' in options, false)
})

test('dispose 聚合：一个不干净就是 false，且只回收自己起的', async () => {
  const a = handle(true)
  const b = handle(false)
  const queue: RemoteDshHandle[] = [a, b]
  const backend = new SshRemoteBackend({
    homeDir: '/h',
    target: TARGET,
    auth: AUTH,
    launch: async () => {
      const next = queue.shift()
      if (next === undefined) throw new Error('队列空了')
      return next as SshRemoteHandle
    },
  })

  await backend.launch({ port: 1, remoteRoot: '/r' })
  await backend.launch({ port: 2, remoteRoot: '/r' })

  assert.deepEqual(await backend.dispose(), { clean: false })
  assert.equal(a.disposed, 1)
  assert.equal(b.disposed, 1)
  // 幂等：再调一次不重复回收。
  assert.deepEqual(await backend.dispose(), { clean: true })
  assert.equal(a.disposed, 1)
})
