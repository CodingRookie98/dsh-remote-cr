import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { applySyncPlan, buildSyncPlan, resetApplyingForTest, type SyncBackend } from './service.ts'
import { readOptout, setMuted, writeOptout } from './optout.ts'

/** L1：optout 本地落盘 + L2：编排（假 exec 跑完整链路）。 */

test('optout：缺文件当空、坏 JSON 当空、写入去重排序、可增删', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-cr-optout-'))
  const file = join(dir, 'sync-optout.json')
  try {
    assert.deepEqual(readOptout(file), [])
    writeFileSync(file, '{oops', 'utf8')
    assert.deepEqual(readOptout(file), [])
    writeOptout(file, ['b', 'a', 'a'])
    assert.deepEqual(readOptout(file), ['a', 'b'])
    assert.deepEqual(setMuted(file, 'c', true), ['a', 'b', 'c'])
    assert.deepEqual(setMuted(file, 'a', false), ['b', 'c'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function backend(payload: unknown, code = 0): { backend: SyncBackend; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    backend: {
      nodeCommand: '/s/bin/node',
      dshCommand: '/s/npm/bin/dsh',
      nodeBin: '/s/bin',
      homeDir: '/home/hui',
      exec: async (script: string) => {
        calls.push(script)
        return { code, stdout: typeof payload === 'string' ? payload : JSON.stringify(payload), stderr: code === 0 ? '' : 'boom' }
      },
    },
  }
}

test('buildSyncPlan：远端空 → 第三方全部 install，官方不出现，muted 透传', async () => {
  const { backend: stub } = backend({ ok: true, bundles: [] })
  const plan = await buildSyncPlan({
    backend: stub,
    targetId: 't1',
    muted: false,
    local: [
      { name: '@deepseek-ai/dsh-base', version: null },
      { name: 'dsh-ops', version: '0.5.5' },
    ],
  })
  assert.deepEqual(plan.entries.map((entry) => entry.name), ['dsh-ops'])
  assert.deepEqual(plan.totals, { install: 1, upToDate: 0, skipped: 0 })
  assert.equal(plan.muted, false)
  assert.equal(plan.profile, 'web')
})

test('buildSyncPlan：远端已装同版本 → up-to-date（不产生 install）', async () => {
  const { backend: stub } = backend({ ok: true, bundles: [{ name: 'dsh-ops', version: '0.5.5' }] })
  const plan = await buildSyncPlan({ backend: stub, targetId: 't1', muted: true, local: [{ name: 'dsh-ops', version: '0.5.5' }] })
  assert.equal(plan.entries[0]?.action, 'up-to-date')
  assert.equal(plan.totals.install, 0)
  assert.equal(plan.muted, true)
})

test('applySyncPlan：requiresRuntime 且没有 runtime → 结构化拒绝，执行 0 次（不拼必然 ENOENT 的命令）', async () => {
  resetApplyingForTest()
  const calls: string[] = []
  const stub: SyncBackend = {
    nodeCommand: 'auto',
    dshCommand: '/w/dsh/apps/cli/lib/bin.js',
    nodeBin: '',
    interpreter: null,
    homeDir: '',
    requiresRuntime: true,
    exec: async (script: string) => {
      calls.push(script)
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  await assert.rejects(
    () => applySyncPlan({ backend: stub, runtime: null, targetId: 'wsl:ubuntu_dev', entries: [{ name: 'dsh-ops', action: 'install', reasonId: 'missing-remote', localVersion: '0.5.5', remoteVersion: null }] }),
    (error: unknown) => {
      const typed = error as { code?: string; nextActions?: readonly string[] }
      assert.equal(typed.code, 'remote/plugin-sync-read-failed')
      assert.ok((typed.nextActions ?? []).length > 0, '铁律 4：失败必须带下一步')
      return true
    },
  )
  assert.equal(calls.length, 0, '拒绝时不许执行任何命令（否则用户会照抄一条跑不通的命令）')
  // 负控：给了 runtime 就必须照常执行（别把门禁写成永远拒绝）
  const results = await applySyncPlan({
    backend: stub,
    runtime: { homeDir: '/home/hui', nodeCommand: '/usr/bin/node', nodeBin: '/usr/bin', dshCommand: '/w/dsh/apps/cli/lib/bin.js', interpreter: '/usr/bin/node', dshRoot: '/w/dsh' },
    targetId: 'wsl:ubuntu_dev',
    entries: [{ name: 'dsh-ops', action: 'install', reasonId: 'missing-remote', localVersion: '0.5.5', remoteVersion: null }],
  })
  assert.deepEqual(results.map((result) => result.ok), [true])
  assert.equal(calls.length, 1)
})

test('buildSyncPlan：远端读取失败 → remote/plugin-sync-read-failed（不让空列表冒充成功）', async () => {
  const { backend: stub } = backend('', 3)
  await assert.rejects(
    () => buildSyncPlan({ backend: stub, targetId: 't1', muted: false, local: [] }),
    (error: unknown) => (error as { code?: string }).code === 'remote/plugin-sync-read-failed',
  )
})

test('applySyncPlan：命令带 PATH 与确切版本；逐条结果回传', async () => {
  resetApplyingForTest()
  const { backend: stub, calls } = backend({ ok: true, bundles: [] })
  const results = await applySyncPlan({
    backend: stub,
    targetId: 't2',
    entries: [
      { name: 'a', action: 'install', reasonId: 'missing-remote', localVersion: '1.0.0', remoteVersion: null },
      { name: 'b', action: 'install', reasonId: 'missing-remote', localVersion: '2.0.0', remoteVersion: null },
    ],
  })
  assert.deepEqual(results.map((result) => result.ok), [true, true])
  assert.equal(calls.length, 2)
  assert.match(calls[0] ?? '', /PATH='\/s\/bin':\$PATH/)
  assert.match(calls[0] ?? '', /'a@1\.0\.0'/)
})

test('applySyncPlan：同一 target 并发执行直接拒绝（避免 pnpm 互踩）', async () => {
  resetApplyingForTest()
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const stub: SyncBackend = {
    nodeCommand: 'node', dshCommand: 'dsh', nodeBin: '/b', homeDir: '/home/hui',
    exec: async () => { await gate; return { code: 0, stdout: '', stderr: '' } },
  }
  const first = applySyncPlan({ backend: stub, targetId: 't3', entries: [{ name: 'a', action: 'install', reasonId: 'missing-remote', localVersion: '1.0.0', remoteVersion: null }] })
  await assert.rejects(
    () => applySyncPlan({ backend: stub, targetId: 't3', entries: [] }),
    (error: unknown) => (error as { code?: string }).code === 'remote/plugin-sync-unsupported',
  )
  release?.()
  await first
  resetApplyingForTest()
})
