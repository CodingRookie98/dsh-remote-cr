/**
 * 这一层决定「远端 dsh 从哪来」，而它的全部输入就是**一条**远端脚本的输出。
 * 所以测试的形态是：给一段假 stdout（标记行），断言走了哪条分支、报什么码、跑了几次往返。
 * 脚本正文本身由 `buildInspectScript` 负责，测试不锁它的字面量——锁的是**判定**。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { TeleportError } from '../errors.ts'
import type { SshTarget } from './config.ts'
import { resolveRemoteDsh, type RemoteExecResult } from './runtime.ts'

const TARGET: SshTarget = {
  alias: 'gcp',
  hostName: '10.0.0.9',
  user: 'hui',
  port: 22,
  proxyJump: [],
  identityFiles: ['/home/hui/.ssh/id_gcp'],
  source: { file: 'C:/Users/hui/.ssh/config', line: 60 },
}

const REMOTE_ROOT = '/home/hui/workspace'

interface InspectShape {
  readonly home?: string
  readonly node?: string
  readonly dsh?: string
  readonly dir?: boolean
  readonly checkout?: boolean
  readonly staging?: string
  /** 故意不给 TELEPORT_END：模拟远端 shell 把输出吃掉。 */
  readonly truncated?: boolean
}

/** 造一条与 `buildInspectScript` 同形的 stdout（标记行，末行 END）。 */
function inspectOut(shape: InspectShape): string {
  const lines = [
    'TELEPORT_HOME=' + (shape.home ?? '/home/hui'),
    'TELEPORT_NODE=' + (shape.node ?? 'v22.22.1'),
    'TELEPORT_DSH=' + (shape.dsh ?? ''),
  ]
  if (shape.dir !== false) lines.push('TELEPORT_DIR=1')
  if (shape.checkout === true) lines.push('TELEPORT_CHECKOUT=1')
  if (shape.staging !== undefined) lines.push('TELEPORT_STAGING=' + shape.staging)
  if (shape.truncated !== true) lines.push('TELEPORT_END=1')
  return lines.join(String.fromCharCode(10)) + String.fromCharCode(10)
}

interface Call {
  readonly script: string
  readonly deadlineMs: number | undefined
}

/**
 * 第一段（检查脚本）回 `inspectOut(...)`；其余由 `rest` 决定，没命中就给 exit 1——
 * 让「漏了一条分支」立刻红，而不是静默通过。
 */
function fakeExec(
  shape: InspectShape,
  rest: (script: string) => RemoteExecResult | undefined = () => ({ code: 0, stdout: '', stderr: '' }),
): { exec: (script: string, deadlineMs?: number) => Promise<RemoteExecResult>; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    exec: async (script, deadlineMs) => {
      calls.push({ script, deadlineMs })
      // 检查脚本用 `p TELEPORT_HOME "$HOME"` 的形式问，不是字面量 `=`。
      if (script.includes('p TELEPORT_HOME')) return { code: 0, stdout: inspectOut(shape), stderr: '' }
      return rest(script) ?? { code: 1, stdout: '', stderr: 'unexpected script' }
    },
  }
}

const base = (home: string, extra: Record<string, unknown> = {}) => ({ homeDir: home, target: TARGET, auth: { kind: 'key' as const }, remoteRoot: REMOTE_ROOT, ...extra })
const stateDirOf = (home: string): string => join(home, '.dsh-teleport', 'bootstrap')

function rethrowAsTeleport(error: unknown, code: string, extra?: (item: TeleportError) => void): true {
  assert.ok(error instanceof TeleportError, '应是 TeleportError，实际 ' + String(error))
  assert.equal(error.code, code)
  extra?.(error)
  return true
}

test('有检出就用检出：argvPrefix 是 node + 检出里的 bin.js，且只跑一条远端命令', async () => {
  const home = mkdtempSync(join(tmpdir(), 'teleport-runtime-'))
  const { exec, calls } = fakeExec({ dir: true, checkout: true })
  try {
    const runtime = await resolveRemoteDsh(base(home, { exec }))
    assert.equal(runtime.source, 'checkout')
    assert.deepEqual(runtime.argvPrefix, ['node', REMOTE_ROOT + '/apps/cli/lib/bin.js'])
    assert.equal(runtime.dshRoot, REMOTE_ROOT)
    assert.equal(calls.length, 1, '检出路径只该花一次远端往返')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('远端目录不存在：remote/path-unreadable，且在 detail 里写出那个目录', async () => {
  const home = mkdtempSync(join(tmpdir(), 'teleport-runtime-'))
  const { exec } = fakeExec({ dir: false })
  try {
    await assert.rejects(() => resolveRemoteDsh(base(home, { exec })), (error: unknown) =>
      rethrowAsTeleport(error, 'remote/path-unreadable', (item) => {
        assert.ok(item.detail.includes('/home/hui/workspace'), item.detail)
      }),
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('staging 装过就复用：一次往返、不装任何东西', async () => {
  const home = mkdtempSync(join(tmpdir(), 'teleport-runtime-'))
  const { exec, calls } = fakeExec({ dir: true, staging: '0.2.2-rc.1' })
  try {
    const runtime = await resolveRemoteDsh(base(home, { exec }))
    assert.equal(runtime.source, 'staging')
    assert.match(runtime.argvPrefix[0] ?? '', /\/\.dsh-teleport\/staging\/[0-9a-f]{16}\/npm\/bin\/dsh$/)
    assert.equal(runtime.dshRoot.split('/').pop()?.length, 16, 'dshRoot 应是 staging/<16 位 id>')
    assert.equal(calls.length, 1, '复用路径只该花一次远端往返：这是首连 ≤10s 门禁的关键')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('staging 没装过就装，装完必须验版本，账本落本地', async () => {
  const home = mkdtempSync(join(tmpdir(), 'teleport-runtime-'))
  const scripts: string[] = []
  const { exec } = fakeExec({ dir: true }, (script) => {
    scripts.push(script)
    if (/npm\/bin\/dsh' --version/.test(script)) return { code: 0, stdout: '0.2.2-rc.1' + String.fromCharCode(10), stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  })
  try {
    const runtime = await resolveRemoteDsh(base(home, { exec, stateDir: stateDirOf(home) }))
    assert.equal(runtime.source, 'staging')
    assert.ok(scripts.length > 1, '没有真的跑引导脚本')
    const id = runtime.dshRoot.split('/').pop() ?? ''
    const ledger = readFileSync(join(stateDirOf(home), id + '.json'), 'utf8')
    assert.match(ledger, /"steps"/, '账本没有落盘：下次会重装一遍')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('装完却跑不出可用版本：remote/bootstrap-failed，输出写明（空）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'teleport-runtime-'))
  const { exec } = fakeExec({ dir: true }, () => ({ code: 0, stdout: String.fromCharCode(10), stderr: '' }))
  try {
    await assert.rejects(() => resolveRemoteDsh(base(home, { exec, stateDir: stateDirOf(home) })), (error: unknown) =>
      rethrowAsTeleport(error, 'remote/bootstrap-failed', (item) => {
        assert.equal(item.phase, 'bootstrap')
        assert.ok(item.detail.includes('（空）'), item.detail)
      }),
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('检查脚本没跑完（缺 END）：remote/probe-incomplete，不把「什么都没问出来」当成「都没有」', async () => {
  const home = mkdtempSync(join(tmpdir(), 'teleport-runtime-'))
  const { exec } = fakeExec({ dir: true, truncated: true })
  try {
    await assert.rejects(() => resolveRemoteDsh(base(home, { exec })), (error: unknown) =>
      rethrowAsTeleport(error, 'remote/probe-incomplete'),
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('远端 home 为空：remote/dsh-missing，因为没有 home 就没有 staging 位置', async () => {
  const home = mkdtempSync(join(tmpdir(), 'teleport-runtime-'))
  const { exec } = fakeExec({ dir: true, home: '' })
  try {
    await assert.rejects(() => resolveRemoteDsh(base(home, { exec })), (error: unknown) =>
      rethrowAsTeleport(error, 'remote/dsh-missing'),
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})