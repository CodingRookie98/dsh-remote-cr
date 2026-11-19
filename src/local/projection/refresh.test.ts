/**
 * M3-3：刷新原语的验收测试（R1/R2 的共同底座）。
 *
 * 五条必验：
 *   1. running true→false 被贴回，updatedAt 变成 ISO 串；
 *   2. 投影有、listed 没有 → 原样保留（availability 不变），只计 missing；
 *   3. listed 里有陌生 sessionId → 不新增（`session/list` 不带 workspaceId，猜就会串台）；
 *   4. 守卫单飞：并发两次拿到同一个 promise，任务只跑一次；
 *   5. 守卫在失败后释放：第一次 reject，第二次能重新执行。
 *
 * store 用真实类（不 mock）：这一层要验的正是「贴回去之后表里长什么样」。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import type { RemoteSessionSummary } from './attach.ts'
import { RefreshGuard, applySessionRefresh } from './refresh.ts'
import { ProjectionStore } from './store.ts'
import type { ProjectedSession, ProjectedWorkspace } from './store.ts'

/** 远端毫秒时间戳的固定样本：断言用它换算，不硬编码字符串。 */
const REMOTE_MS = 1_760_000_000_000

function workspace(id: string, overrides: Partial<ProjectedWorkspace> = {}): ProjectedWorkspace {
  return {
    id,
    localPath: '\\\\wsl.localhost\\ubuntu_dev\\home\\hui\\' + id,
    remotePath: '/home/hui/' + id,
    backend: 'wsl',
    distro: 'ubuntu_dev',
    title: id,
    availability: 'online',
    ...overrides,
  }
}

function session(id: string, workspaceId: string, overrides: Partial<ProjectedSession> = {}): ProjectedSession {
  return {
    sessionId: id,
    workspaceId,
    title: id,
    updatedAt: '2026-01-01T00:00:00.000Z',
    running: false,
    availability: 'online',
    ...overrides,
  }
}

function summary(sessionId: string, overrides: Partial<RemoteSessionSummary> = {}): RemoteSessionSummary {
  return { sessionId, updatedAt: REMOTE_MS, running: false, blank: false, ...overrides }
}

/** 手工 deferred：不依赖 `Promise.withResolvers` 在运行时的可用性。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

test('R2 基础：running true→false 被贴回，updatedAt 变成 ISO 串', () => {
  const store = new ProjectionStore()
  store.upsertWorkspace(workspace('ws'))
  store.upsertSession(session('s1', 'ws', { running: true, updatedAt: '2026-01-01T00:00:00.000Z' }))

  const outcome = applySessionRefresh({ store, listed: [summary('s1', { running: false, updatedAt: REMOTE_MS })] })

  assert.deepEqual(outcome, { updated: 1, missing: 0 })
  const row = store.sessions('ws')[0]
  assert.equal(row?.running, false, '远端的 running=false 必须落到投影上')
  assert.equal(row?.updatedAt, new Date(REMOTE_MS).toISOString(), 'updatedAt 必须是 ISO 串')
  assert.match(String(row?.updatedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.equal(row?.availability, 'online')
})

test('投影有、listed 没有：原样保留（availability 不变），只计 missing', () => {
  const store = new ProjectionStore()
  store.upsertWorkspace(workspace('ws'))
  store.upsertSession(session('alive', 'ws', { running: true }))
  // 这条不在 listed 里：必须「不删、不改 availability」。刻意用 offline 起手，
  // 免得实现把整表无脑刷成 online 也能蒙过去。
  store.upsertSession(session('gone', 'ws', { running: true, availability: 'offline', updatedAt: '2026-02-02T00:00:00.000Z' }))
  const before = store.size

  const outcome = applySessionRefresh({ store, listed: [summary('alive', { running: false })] })

  assert.deepEqual(outcome, { updated: 1, missing: 1 })
  assert.deepEqual(store.size, before, '本轮不删，条目数必须不变')
  const gone = store.sessions('ws').find((entry) => entry.sessionId === 'gone')
  assert.equal(gone?.availability, 'offline', 'missing 的会话不该被改成 online')
  assert.equal(gone?.running, true, 'missing 的会话字段原样保留')
  assert.equal(gone?.updatedAt, '2026-02-02T00:00:00.000Z')
})

test('listed 里有陌生 sessionId：不新增条目（store.size 不变）', () => {
  const store = new ProjectionStore()
  store.upsertWorkspace(workspace('ws'))
  store.upsertSession(session('known', 'ws', { running: true }))
  const before = store.size

  const outcome = applySessionRefresh({
    store,
    listed: [summary('known', { running: false }), summary('stranger', { running: true })],
  })

  assert.deepEqual(outcome, { updated: 1, missing: 0 })
  assert.deepEqual(store.size, before, '陌生 sessionId 不该凭空建出投影条目')
  assert.deepEqual(store.sessions('ws').map((entry) => entry.sessionId), ['known'])
})

test('刷新不改面板顺序：原地 patch，不把命中的行挪到末尾', () => {
  const store = new ProjectionStore()
  store.upsertWorkspace(workspace('ws'))
  for (const id of ['s1', 's2', 's3']) store.upsertSession(session(id, 'ws'))
  const order = store.sessions('ws').map((entry) => entry.sessionId)

  applySessionRefresh({
    store,
    listed: [summary('s3', { running: true }), summary('s1', { running: true }), summary('s2', { running: true })],
  })

  assert.deepEqual(store.sessions('ws').map((entry) => entry.sessionId), order, '刷新只改字段，不该重排行序')
  assert.equal(store.sessions('ws').find((entry) => entry.sessionId === 's3')?.running, true)
})

test('store.patchSession：投影里没有的 id 返回 false 且不新增（刷新路径不造条目）', () => {
  const store = new ProjectionStore()
  store.upsertWorkspace(workspace('ws'))
  store.upsertSession(session('known', 'ws'))
  const before = store.size

  assert.equal(store.patchSession(session('ghost', 'ws')), false)
  assert.deepEqual(store.size, before)
  assert.deepEqual(store.sessions('ws').map((entry) => entry.sessionId), ['known'])
})

test('守卫单飞：并发两次 run 拿到同一个 promise，任务只跑一次', async () => {
  const guard = new RefreshGuard()
  const gate = deferred<string>()
  let calls = 0
  const task = (): Promise<string> => {
    calls += 1
    return gate.promise
  }

  const first = guard.run('target-A', task)
  const second = guard.run('target-A', task)

  assert.equal(first, second, '同一 key 的并发调用必须共享同一个 promise 对象')
  assert.equal(guard.busy('target-A'), true)
  gate.resolve('done')

  assert.equal(await first, 'done')
  assert.equal(await second, 'done')
  assert.equal(calls, 1, '任务只该被执行一次')
  assert.equal(guard.busy('target-A'), false, 'settle 之后不该再报忙')
})

test('守卫在任务失败后释放：第一次 reject，第二次能重新执行', async () => {
  const guard = new RefreshGuard()
  let calls = 0

  await assert.rejects(
    guard.run('target-A', async () => {
      calls += 1
      throw new Error('boom')
    }),
    /boom/,
  )

  assert.equal(guard.busy('target-A'), false, '失败后映射必须清掉，否则第二次会复用已 settled 的 promise')
  const second = await guard.run('target-A', async () => {
    calls += 1
    return 'ok'
  })
  assert.equal(second, 'ok')
  assert.equal(calls, 2)
})
