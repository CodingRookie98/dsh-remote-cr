import assert from 'node:assert/strict'
import test from 'node:test'

import type { SyncEntry } from '../shared/plugin-sync.ts'
import {
  beginApply,
  CLOSED,
  closeSync,
  failSync,
  finishApply,
  openSync,
  receiveResult,
  receiveSyncPlan,
  resultTotals,
  syncReport,
  syncTargetOf,
  hostFailureExtras,
  selectAllSync,
  shouldAutoOpenSync,
  syncBlockedReason,
  syncGroups,
  toggleSyncEntry,
  type SyncPlanLike,
} from './sync-state.ts'

function entry(name: string, action: SyncEntry['action'] = 'install'): SyncEntry {
  return { name, action, reasonId: action === 'install' ? 'missing-remote' : 'none', localVersion: '1.0.0', remoteVersion: null }
}

function plan(entries: readonly SyncEntry[]): SyncPlanLike {
  const install = entries.filter((item) => item.action === 'install').length
  return {
    targetId: 'ssh:demo@22',
    profile: 'web',
    entries,
    totals: { install, upToDate: entries.length - install, skipped: 0 },
    muted: false,
  }
}

test('失败面的可照抄命令与远端原文：原样保留，空串折成 null（R1 BLK-4）', () => {
  const keep = hostFailureExtras({ command: 'npm install --global --prefix /s/npm @deepseek-ai/dsh@0.2.2-rc.4', logTail: 'npm ERR! EACCES' })
  assert.match(String(keep.command), /npm install --global --prefix \/s\/npm/)
  assert.match(String(keep.logTail), /EACCES/)
  assert.deepEqual(hostFailureExtras({}), { command: null, logTail: null })
  assert.deepEqual(hostFailureExtras({ command: '   ', logTail: '\n' }), { command: null, logTail: null }, '空白不该画出一个空框')
  assert.deepEqual(hostFailureExtras({ command: ' npm i ', logTail: ' x ' }), { command: 'npm i', logTail: 'x' })
})

test('自动弹窗：有可同步项且未静音才弹（R2-S12）', () => {
  assert.equal(shouldAutoOpenSync({ muted: false, totals: { install: 2 } }), true)
  assert.equal(shouldAutoOpenSync({ muted: true, totals: { install: 2 } }), false, '静音后不许再打扰')
  assert.equal(shouldAutoOpenSync({ muted: false, totals: { install: 0 } }), false, '没差异不弹')
})

test('runtime=null 且该后端必须有 runtime → 拦下；SSH 的 PATH 形态与旧宿主不拦', () => {
  const base = plan([entry('a')])
  assert.equal(syncBlockedReason({ ...base, runtime: null, requiresRuntime: true }), 'no-runtime')
  assert.equal(syncBlockedReason({ ...base, runtime: { dshCommand: '/w/apps/cli/lib/bin.js' }, requiresRuntime: true }), null)
  // SSH 远端把 dsh 装在 PATH 上时 runtime 也是 null，但兜底命令可用 —— 判据必须与后端同形。
  assert.equal(syncBlockedReason({ ...base, runtime: null, requiresRuntime: false }), null)
  assert.equal(syncBlockedReason(base), null, '没有这个字段的老宿主不该被误拦')
})

test('打开 → loading；计划到达 → ready 且默认全选可同步项', () => {
  assert.deepEqual(openSync(), { phase: 'loading' })
  const state = receiveSyncPlan(plan([entry('a'), entry('b'), entry('c', 'up-to-date')]))
  assert.equal(state.phase, 'ready')
  if (state.phase !== 'ready') return
  assert.deepEqual(state.selected, ['a', 'b'], '只默认勾选 install 项')
})

test('勾选/全选：只影响 install 项；非 ready 态调用不动', () => {
  const ready = receiveSyncPlan(plan([entry('a'), entry('b')]))
  const toggled = toggleSyncEntry(ready, 'a')
  if (toggled.phase !== 'ready') throw new Error('unexpected')
  assert.deepEqual(toggled.selected, ['b'])
  const none = selectAllSync(toggled, false)
  if (none.phase !== 'ready') throw new Error('unexpected')
  assert.deepEqual(none.selected, [])
  assert.deepEqual(toggleSyncEntry(CLOSED, 'a'), CLOSED)
})

test('执行流程：ready → applying → 逐条结果 → done；没选中项时不许开始', () => {
  const ready = receiveSyncPlan(plan([entry('a')]))
  const empty = selectAllSync(ready, false)
  assert.equal(beginApply(empty).phase, 'ready', '没选中项时原地不动')

  const applying = beginApply(ready)
  assert.equal(applying.phase, 'applying')
  const withResult = receiveResult(applying, { name: 'a', ok: true })
  if (withResult.phase !== 'applying') throw new Error('unexpected')
  const done = finishApply(withResult)
  assert.equal(done.phase, 'done')
  if (done.phase !== 'done') return
  assert.deepEqual(resultTotals(done.results), { ok: 1, failed: 0 })
})

test('分组：可同步 / 已最新 / 其余（skip-path、blocked、remote-newer 都进 skipped）', () => {
  const groups = syncGroups(plan([entry('a'), entry('b', 'up-to-date'), entry('c', 'skip-path'), entry('d', 'blocked')]))
  assert.deepEqual(groups.installable.map((item) => item.name), ['a'])
  assert.deepEqual(groups.upToDate.map((item) => item.name), ['b'])
  assert.deepEqual(groups.skipped.map((item) => item.name), ['c', 'd'])
})

test('失败与关闭：failed 带结构化原因；close 回 closed', () => {
  const failed = failSync({ code: 'remote/plugin-sync-read-failed', detail: 'x', nextActions: ['重试'] })
  assert.equal(failed.phase, 'failed')
  assert.deepEqual(closeSync(), CLOSED)
})

test('syncReport：只含事实与码，不含远端路径；成功与失败行可区分', () => {
  let state = receiveSyncPlan(plan([entry('a'), entry('b')]))
  state = beginApply(state)
  state = receiveResult(state, { name: 'a', ok: true })
  state = receiveResult(state, { name: 'b', ok: false, code: 'remote/plugin-sync-apply-failed', detail: '退出码 1', nextActions: ['重试'] })
  state = finishApply(state)
  const report = syncReport(state)
  assert.match(report, /^dsh-remote-cr plugin sync/)
  assert.match(report, /ok {3}a/)
  assert.match(report, /FAIL b remote\/plugin-sync-apply-failed — 退出码 1/)
  assert.ok(!report.includes('/home/'), '不把远端路径抄进报告')
  assert.equal(syncReport(CLOSED), '')
})

test('syncTargetOf：接入入参 → 同步目标（N1 的根因修复点）', () => {
  assert.deepEqual(
    syncTargetOf({ backend: 'ssh', alias: 'demo', port: 22, remoteRoot: '/home/hui' }),
    { backend: 'ssh', alias: 'demo', port: 22, remoteRoot: '/home/hui' },
  )
  assert.deepEqual(
    syncTargetOf({ backend: 'wsl', distro: 'ubuntu_dev', port: 8899, remoteRoot: '/home/hui' }),
    { backend: 'wsl', distro: 'ubuntu_dev', port: 8899, remoteRoot: '/home/hui' },
  )
  assert.equal(syncTargetOf({ backend: 'docker', port: 1, remoteRoot: '/x' }), null, 'docker 暂不支持')
  assert.equal(syncTargetOf({ backend: 'ssh', alias: '', port: 22, remoteRoot: '/x' }), null)
  assert.equal(syncTargetOf({ backend: 'wsl', distro: '', port: 22, remoteRoot: '/x' }), null)
})
