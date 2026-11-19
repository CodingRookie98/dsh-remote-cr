import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProjectionSnapshotInfo } from '../shared/api.ts'
import { createRefreshRunner } from './refresh-runner.ts'

interface Failure {
  readonly code: string
}

function snapshot(overrides: Partial<ProjectionSnapshotInfo> = {}): ProjectionSnapshotInfo {
  return {
    workspaces: [],
    sessions: [],
    connected: true,
    target: null,
    link: 'connected',
    envPolicy: null,
    attach: null,
    stale: false,
    defaults: { port: 1, remoteRoot: '/r' },
    ...overrides,
  }
}

/** 与 React 的 setState 同形的假实现：记下每一次 updater 的结果。 */
function errorSlot(initial: Failure | null = null): {
  apply: (update: (current: Failure | null) => Failure | null) => void
  readonly current: Failure | null
} {
  let value = initial
  return {
    apply: (update) => {
      value = update(value)
    },
    get current(): Failure | null {
      return value
    },
  }
}

test('未连接：不发请求、不补读、不报错', async () => {
  let refreshed = 0
  let reread = 0
  const runner = createRefreshRunner<Failure>({
    current: () => snapshot({ connected: false }),
    refresh: async () => {
      refreshed += 1
      return snapshot()
    },
    reread: async () => {
      reread += 1
      return snapshot()
    },
    applySnapshot: () => assert.fail('未连接时不许写快照'),
    applyError: () => assert.fail('未连接时不许报错'),
    shape: () => ({ code: 'x' }),
  })
  await runner.run()
  assert.equal(refreshed, 0)
  assert.equal(reread, 0)
})

test('成功：应用新快照，且只撤自己写进去的那条错误', async () => {
  const slot = errorSlot({ code: 'remote/probe-failed' })
  let applied: ProjectionSnapshotInfo | null = null
  const runner = createRefreshRunner<Failure>({
    current: () => snapshot(),
    refresh: async () => snapshot({ stale: false }),
    reread: async () => snapshot(),
    applySnapshot: (next) => {
      applied = next
    },
    applyError: slot.apply,
    shape: () => ({ code: 'x' }),
  })
  await runner.run()
  assert.ok(applied !== null, '成功必须写快照')
  assert.deepEqual(slot.current, { code: 'remote/probe-failed' }, '别人的错误不许被成功路径抹掉')
})

test('失败：绝不写快照（不清表），写错误，并原样抛出', async () => {
  const slot = errorSlot()
  const boom = new Error('boom')
  let applied = 0
  const runner = createRefreshRunner<Failure>({
    current: () => snapshot(),
    refresh: async () => {
      throw boom
    },
    reread: async () => snapshot({ stale: true }),
    applySnapshot: () => {
      applied += 1
    },
    applyError: slot.apply,
    shape: () => ({ code: 'remote/disconnected' }),
  })
  await assert.rejects(runner.run(), /boom/)
  // 补读会写一次快照（宿主那一帧），但**绝不是 null**：第一次写必须是补读的结果。
  assert.equal(applied, 1, '失败路径只允许补读那一次写，不许清表')
  assert.deepEqual(slot.current, { code: 'remote/disconnected' })
})

test('失败后补读：把宿主置了 stale 的那一帧交给面板', async () => {
  let applied: ProjectionSnapshotInfo | null = null
  const runner = createRefreshRunner<Failure>({
    current: () => snapshot(),
    refresh: async () => {
      throw new Error('nope')
    },
    reread: async () => snapshot({ stale: true }),
    applySnapshot: (next) => {
      applied = next
    },
    applyError: () => {},
    shape: () => ({ code: 'remote/cancelled' }),
  })
  await assert.rejects(runner.run())
  assert.equal((applied as ProjectionSnapshotInfo | null)?.stale, true, '补读结果必须带 stale=true')
})

test('attach 进行中不补读：那会与 settleSnapshot 的每 100ms 写入抢方向盘', async () => {
  let reread = 0
  const runner = createRefreshRunner<Failure>({
    current: () => snapshot({ attach: { phase: 'probe', startedAt: 1 } }),
    refresh: async () => {
      throw new Error('nope')
    },
    reread: async () => {
      reread += 1
      return snapshot()
    },
    applySnapshot: () => {},
    applyError: () => {},
    shape: () => ({ code: 'x' }),
  })
  await assert.rejects(runner.run())
  assert.equal(reread, 0)
})

test('重跑：先前的失败被自己撤掉，别人的错误仍然保留', async () => {
  const slot = errorSlot()
  let fail = true
  const runner = createRefreshRunner<Failure>({
    current: () => snapshot(),
    refresh: async () => {
      if (fail) throw new Error('nope')
      return snapshot()
    },
    reread: async () => snapshot({ stale: true }),
    applySnapshot: () => {},
    applyError: slot.apply,
    shape: () => ({ code: 'remote/disconnected' }),
  })
  await assert.rejects(runner.run())
  assert.deepEqual(slot.current, { code: 'remote/disconnected' })
  fail = false
  await runner.run()
  assert.equal(slot.current, null, '成功要撤掉自己那条错误')
  assert.equal(runner.lastFailure, null)
})
