import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { TeleportError } from '../errors.ts'
import type { SshTarget } from './config.ts'
import type { SshProbeResult } from './probe.ts'
import { resolveRemoteDsh, type RemoteExecResult } from './runtime.ts'

/**
 * 这一层决定「远端 dsh 从哪来」，所以每条测试都盯着**分支的选择**，不盯着脚本正文：
 * 脚本正文由 `bootstrap.test.ts` 锁，这里只关心「哪条路被走了、走不通时报什么码」。
 */

const TARGET: SshTarget = {
  alias: 'gcp',
  hostName: '10.0.0.9',
  user: 'hui',
  source: { file: 'C:/Users/hui/.ssh/config', line: 60 },
  port: 22,
  proxyJump: [],
  identityFiles: ['/home/hui/.ssh/id_gcp'],
}

const REMOTE_ROOT = '/home/hui/workspace'
const NL = String.fromCharCode(10)

function fakeProbe(home = '/home/hui'): SshProbeResult {
  return {
    probe: {
      kind: 'ssh',
      target: 'hui@10.0.0.9',
      home,
      nodeVersion: 'v22.22.1',
      dshVersion: undefined,
      hasDshHome: true,
      mirroredNetwork: undefined,
    },
    system: { platform: 'Linux', arch: 'x86_64', kernel: '6.8.0' },
    parsed: { values: {}, missing: [], conflicts: [], complete: true },
  } as unknown as SshProbeResult
}

interface ExecCall {
  readonly script: string
  readonly deadlineMs: number | undefined
}

/** 按脚本内容分派；没命中的脚本一律 exit 1（让「漏了一条分支」立刻红）。 */
function fakeExec(handler: (script: string) => RemoteExecResult | undefined): {
  exec: (script: string, deadlineMs?: number) => Promise<RemoteExecResult>
  calls: ExecCall[]
} {
  const calls: ExecCall[] = []
  return {
    calls,
    exec: async (script, deadlineMs) => {
      calls.push({ script, deadlineMs })
      const result = handler(script)
      return result ?? { code: 1, stdout: '', stderr: 'unexpected script' }
    },
  }
}

const stateDirOf = (home: string): string => join(home, '.dsh-teleport', 'bootstrap')
const IS_CHECKOUT_PROBE = 'apps/cli/lib/bin.js'
const IS_STAGING_FAST = 'TELEPORT_STAGING_DSH='
const IS_VERIFY = /npm\/bin\/dsh' --version/

test('远端有检出就用检出：不再探测、不装任何东西', async () => {
  const home = mkdtempSync(join(tmpdir(), 'teleport-runtime-'))
  let probed = 0
  const { exec, calls } = fakeExec((script) =>
    script.includes(IS_CHECKOUT_PROBE) ? { code: 0, stdout: 'TELEPORT_CHECKOUT=1' + NL, stderr: '' } : undefined,
  )
  try {
    const runtime = await resolveRemoteDsh({
      homeDir: home,
      target: TARGET,
      auth: { kind: 'key' },
      remoteRoot: REMOTE_ROOT,
      exec,
      probe: async () => {
        probed += 1
        return fakeProbe()
      },
    })
    assert.equal(runtime.source, 'checkout')
    assert.deepEqual(runtime.argvPrefix, ['node', REMOTE_ROOT + '/apps/cli/lib/bin.js'])
    assert.equal(runtime.dshRoot, REMOTE_ROOT)
    assert.equal(probed, 0, '有检出还去探测，等于每次接入多一次 ssh 往返')
    assert.equal(calls.length, 1, '检出路径只该跑一条远端命令')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('远端目录不存在时报 remote/path-unreadable，不装作能装', async () => {
  const home = mkdtempSync(join(tmpdir(), 'teleport-runtime-'))
  const { exec } = fakeExec((script) => (script.includes('[ -d ') ? { code: 1, stdout: '', stderr: '' } : undefined))
  try {
    await assert.rejects(
      () =>
        resolveRemoteDsh({
          homeDir: home,
          target: TARGET,
          auth: { kind: 'key' },
          remoteRoot: '/home/hui/nope',
          exec,
          probe: async () => fakeProbe(),
        }),
      (error: unknown) => {
        assert.ok(error instanceof TeleportError)
        assert.equal(error.code, 'remote/path-unreadable')
        assert.ok(error.detail.includes('/home/hui/nope'), error.detail)
        return true
      },
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('没有检出但 staging 已装过：复用那份，不重装', async () => {
  const home = mkdtempSync(join(tmpdir(), 'teleport-runtime-'))
  const { exec, calls } = fakeExec((script) => {
    if (script.includes(IS_CHECKOUT_PROBE)) return { code: 1, stdout: '', stderr: '' }
    if (script.includes('[ -d ')) return { code: 0, stdout: 'yes' + NL, stderr: '' }
    if (script.includes(IS_STAGING_FAST)) return { code: 0, stdout: 'TELEPORT_STAGING_DSH=0.2.2-rc.1' + NL, stderr: '' }
    return undefined
  })
  try {
    const runtime = await resolveRemoteDsh({
      homeDir: home,
      target: TARGET,
      auth: { kind: 'key' },
      remoteRoot: REMOTE_ROOT,
      exec,
      probe: async () => fakeProbe(),
    })
    assert.equal(runtime.source, 'staging')
    assert.match(runtime.argvPrefix[0] ?? '', /\/\.dsh-teleport\/staging\/[0-9a-f]{16}\/npm\/bin\/dsh$/)
    assert.equal(calls.length, 3, '复用路径只该跑：检出探测 / 目录存在 / staging 版本')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('staging 没装过就装，装完必须验版本，账本落本地', async () => {
  const home = mkdtempSync(join(tmpdir(), 'teleport-runtime-'))
  const scripts: string[] = []
  const execWithVerify = async (script: string): Promise<RemoteExecResult> => {
    scripts.push(script)
    if (script.includes(IS_CHECKOUT_PROBE)) return { code: 1, stdout: '', stderr: '' }
    if (script.includes('[ -d ')) return { code: 0, stdout: 'yes' + NL, stderr: '' }
    if (script.includes(IS_STAGING_FAST)) return { code: 1, stdout: '', stderr: '' }
    if (IS_VERIFY.test(script)) return { code: 0, stdout: '0.2.2-rc.1' + NL, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  try {
    const runtime = await resolveRemoteDsh({
      homeDir: home,
      target: TARGET,
      auth: { kind: 'key' },
      remoteRoot: REMOTE_ROOT,
      exec: execWithVerify,
      stateDir: stateDirOf(home),
      probe: async () => fakeProbe(),
    })
    assert.equal(runtime.source, 'staging')
    assert.match(runtime.argvPrefix[0] ?? '', /npm\/bin\/dsh$/)
    assert.ok(scripts.some((item) => item.includes('.dsh-teleport/staging/')), '没有真的跑一句引导脚本')
    const ledgerDir = stateDirOf(home)
    const id = runtime.dshRoot.split('/').pop() ?? ''
    const ledger = readFileSync(join(ledgerDir, id + '.json'), 'utf8')
    assert.match(ledger, /"steps"/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('引导器报成功但 dsh 跑不出可用版本：remote/bootstrap-failed，绝不「大概能跑」', async () => {
  const home = mkdtempSync(join(tmpdir(), 'teleport-runtime-'))
  const { exec } = fakeExec((script) => {
    if (script.includes(IS_CHECKOUT_PROBE)) return { code: 1, stdout: '', stderr: '' }
    if (script.includes('[ -d ')) return { code: 0, stdout: 'yes' + NL, stderr: '' }
    if (script.includes(IS_STAGING_FAST)) return { code: 1, stdout: '', stderr: '' }
    if (IS_VERIFY.test(script)) return { code: 0, stdout: NL, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  })
  try {
    await assert.rejects(
      () =>
        resolveRemoteDsh({
          homeDir: home,
          target: TARGET,
          auth: { kind: 'key' },
          remoteRoot: REMOTE_ROOT,
          exec,
          stateDir: stateDirOf(home),
          probe: async () => fakeProbe(),
        }),
      (error: unknown) => {
        assert.ok(error instanceof TeleportError)
        assert.equal(error.code, 'remote/bootstrap-failed')
        assert.equal(error.phase, 'bootstrap')
        assert.ok(error.detail.includes('（空）'), error.detail)
        return true
      },
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('探测拿不到远端 home 就停下：没有 home 就没有 staging 位置', async () => {
  const home = mkdtempSync(join(tmpdir(), 'teleport-runtime-'))
  const { exec } = fakeExec((script) => {
    if (script.includes(IS_CHECKOUT_PROBE)) return { code: 1, stdout: '', stderr: '' }
    if (script.includes('[ -d ')) return { code: 0, stdout: 'yes' + NL, stderr: '' }
    return undefined
  })
  try {
    await assert.rejects(
      () =>
        resolveRemoteDsh({
          homeDir: home,
          target: TARGET,
          auth: { kind: 'key' },
          remoteRoot: REMOTE_ROOT,
          exec,
          probe: async () => fakeProbe(''),
        }),
      (error: unknown) => {
        assert.ok(error instanceof TeleportError)
        assert.equal(error.code, 'remote/dsh-missing')
        return true
      },
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})