import assert from 'node:assert/strict'
import test from 'node:test'

import { RemoteCrError } from '../errors.ts'
import type { RemoteDshHandle } from '../handle.ts'
import { WslRemoteBackend, type RunInDistroLike } from './remote-backend.ts'

const M = '__DSH_REMOTE_CR_PROBE__'

function probeOut(lines: readonly string[]): string {
  return lines.map((line) => M + line + '\n').join('')
}

const FULL = probeOut([
  'platform=Linux',
  'arch=x86_64',
  'kernel=6.18.54.1-microsoft-standard-WSL2',
  'home=/home/hui',
  'node=v24.22.1',
  'dsh=0.2.1-rc.5',
  'dshhome=1',
  'end=1',
])

interface Recorded {
  executable: string
  distro: string
  command: readonly string[]
  timeoutMs: number | undefined
}

function fakeRun(output: string, sink: Recorded[]): RunInDistroLike {
  return async (executable, distro, command, options) => {
    sink.push({ executable, distro, command, timeoutMs: options?.timeoutMs })
    return { stdoutText: output, stderrText: '', exitCode: 0 }
  }
}

function fakeHandle(clean: boolean): RemoteDshHandle & { disposed: number } {
  const handle = {
    disposed: 0,
    endpoint: { host: '127.0.0.1', port: 8899, token: 't' },
    log: () => '',
    dispose: async () => {
      handle.disposed += 1
      return clean
    },
  }
  return handle
}

test('probe 把脚本跑在目标发行版里，字段逐个映射到 BackendProbe', async () => {
  const calls: Recorded[] = []
  const backend = new WslRemoteBackend({
    distro: 'ubuntu_dev',
    executable: 'wsl.exe',
    runInDistro: fakeRun(FULL, calls),
  })

  const probe = await backend.probe()

  assert.equal(backend.kind, 'wsl')
  assert.equal(backend.target, 'ubuntu_dev')
  assert.equal(probe.kind, 'wsl')
  assert.equal(probe.target, 'ubuntu_dev')
  assert.equal(probe.home, '/home/hui')
  assert.equal(probe.nodeVersion, 'v24.22.1')
  assert.equal(probe.dshVersion, '0.2.1-rc.5')
  assert.equal(probe.hasDshHome, true)
  // 没探测就留空：false 会被上层读成「确认是 NAT 模式」。
  assert.equal(probe.mirroredNetwork, undefined)

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.distro, 'ubuntu_dev')
  assert.deepEqual(calls[0]?.command.slice(0, 2), ['sh', '-c'])
  assert.equal(calls[0]?.timeoutMs, 20_000)
})

test('probe 的脚本正文里带结束标记：没它就无法证明真的跑完了', async () => {
  const calls: Recorded[] = []
  const backend = new WslRemoteBackend({ distro: 'd', runInDistro: fakeRun(FULL, calls) })
  await backend.probe()
  const script = calls[0]?.command[2] ?? ''
  // 标记是 printf 拼出来的（`$M` + `end`），脚本文本里只有这一行 `p end 1`。
  // script 已被 shellQuote 包成单个单引号串，末尾还有个 `'`。
  assert.match(script, /; p end 1/)
})

test('缺结束标记 ⇒ remote/probe-incomplete，不猜半个结果', async () => {
  const partial = probeOut(['platform=Linux', 'home=/home/hui'])
  const backend = new WslRemoteBackend({ distro: 'd', runInDistro: fakeRun(partial, []) })
  await assert.rejects(backend.probe(), (error: unknown) => {
    assert.ok(error instanceof RemoteCrError)
    assert.equal(error.code, 'remote/probe-incomplete')
    assert.match(error.detail, /结束标记/)
    return true
  })
})

test('同一字段两个值 ⇒ 也判不完整（说明输出被重放或机器被换过）', async () => {
  const conflicted = probeOut([
    'kernel=6.8.0',
    'home=/home/hui',
    'kernel=6.9.0',
    'end=1',
  ])
  const backend = new WslRemoteBackend({ distro: 'd', runInDistro: fakeRun(conflicted, []) })
  await assert.rejects(backend.probe(), (error: unknown) => {
    assert.ok(error instanceof RemoteCrError)
    assert.match(error.detail, /kernel/)
    return true
  })
})

test('launch 把请求原样交给 launchRemoteDsh，并记住句柄', async () => {
  const seen: unknown[] = []
  const handle = fakeHandle(true)
  const backend = new WslRemoteBackend({
    distro: 'ubuntu_dev',
    executable: 'wsl.exe',
    runInDistro: fakeRun(FULL, []),
    launch: async (options) => {
      seen.push(options)
      return handle
    },
  })

  const launched = await backend.launch({ port: 8899, remoteRoot: '/home/hui/dsh', nodeCommand: 'node' })

  assert.equal(launched, handle)
  assert.deepEqual(seen, [
    {
      executable: 'wsl.exe',
      distro: 'ubuntu_dev',
      remoteRoot: '/home/hui/dsh',
      port: 8899,
      nodeCommand: 'node',
    },
  ])
})

test('dispose 回收自己起的每个句柄；第二次调用是空操作', async () => {
  const first = fakeHandle(true)
  const second = fakeHandle(true)
  const queue = [first, second]
  const backend = new WslRemoteBackend({
    distro: 'd',
    runInDistro: fakeRun(FULL, []),
    launch: async () => {
      const next = queue.shift()
      if (next === undefined) throw new Error('队列空了')
      return next
    },
  })

  await backend.launch({ port: 1, remoteRoot: '/r' })
  await backend.launch({ port: 2, remoteRoot: '/r' })

  assert.deepEqual(await backend.dispose(), { clean: true })
  assert.equal(first.disposed, 1)
  assert.equal(second.disposed, 1)
  assert.deepEqual(await backend.dispose(), { clean: true })
  assert.equal(first.disposed, 1)
})

test('任一句柄不干净 ⇒ clean=false，不被别的干净句柄盖过去', async () => {
  const ok = fakeHandle(true)
  const dirty = fakeHandle(false)
  const queue = [ok, dirty]
  const backend = new WslRemoteBackend({
    distro: 'd',
    runInDistro: fakeRun(FULL, []),
    launch: async () => {
      const next = queue.shift()
      if (next === undefined) throw new Error('队列空了')
      return next
    },
  })

  await backend.launch({ port: 1, remoteRoot: '/r' })
  await backend.launch({ port: 2, remoteRoot: '/r' })

  assert.deepEqual(await backend.dispose(), { clean: false })
})
