import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MAX_PROJECTED_SESSIONS,
  MAX_PROJECTED_WORKSPACES,
  ProjectionStore,
  type ProjectedSession,
  type ProjectedWorkspace,
} from './store.ts'

const NEG = process.env.NEGATIVE_CONTROL === '1'

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
  return { sessionId: id, workspaceId, title: id, updatedAt: '2026-10-31T00:00:00.000Z', running: false, availability: 'online', ...overrides }
}

test('upsert 后按新→旧返回（最后写入的排最前）', () => {
  const store = new ProjectionStore()
  store.upsertWorkspace(workspace('a'))
  store.upsertWorkspace(workspace('b'))
  store.upsertWorkspace(workspace('c'))
  // NEGATIVE_CONTROL: 变异让 upsert 不再「先删再插」，重复 upsert 不再提升优先级。
  assert.deepEqual(store.workspaces().map((entry) => entry.id), NEG ? ['a', 'b', 'c'] : ['c', 'b', 'a'])
})

test('重复 upsert 同一 id 不新增条目，但把它挪到最新', () => {
  const store = new ProjectionStore()
  store.upsertWorkspace(workspace('a'))
  store.upsertWorkspace(workspace('b'))
  store.upsertWorkspace(workspace('a', { title: 'a2' }))
  assert.equal(store.size.workspaces, 2)
  const rows = store.workspaces()
  assert.equal(rows[0]?.id, 'a')
  assert.equal(rows[0]?.title, 'a2')
})

test('容量有界：超出上限时丢最旧的，不丢最新的', () => {
  const store = new ProjectionStore()
  for (let index = 0; index < MAX_PROJECTED_WORKSPACES + 3; index += 1) store.upsertWorkspace(workspace('w' + String(index)))
  assert.equal(store.size.workspaces, MAX_PROJECTED_WORKSPACES)
  const ids = store.workspaces().map((entry) => entry.id)
  // 最新的那条一定在；最旧的三条一定不在。
  assert.equal(ids[0], 'w' + String(MAX_PROJECTED_WORKSPACES + 2))
  assert.equal(ids.includes('w0'), false)
  assert.equal(ids.includes('w2'), false)

  const sessions = new ProjectionStore()
  for (let index = 0; index < MAX_PROJECTED_SESSIONS + 2; index += 1) sessions.upsertSession(session('s' + String(index), 'ws'))
  assert.equal(sessions.size.sessions, MAX_PROJECTED_SESSIONS)
})

test('markAllOffline 只改状态、不删条目（A7：断线后状态可见）', () => {
  const store = new ProjectionStore()
  store.upsertWorkspace(workspace('a'))
  store.upsertSession(session('s1', 'a'))
  store.markAllOffline()
  assert.equal(store.size.workspaces, 1)
  assert.equal(store.size.sessions, 1)
  assert.equal(store.workspaces()[0]?.availability, 'offline')
  assert.equal(store.sessions('a')[0]?.availability, 'offline')
  // 幂等：再标一次不炸、不重复。
  store.markAllOffline()
  assert.equal(store.size.workspaces, 1)
})

test('replaceAll 以远端快照为准：远端删掉的条目本地不留', () => {
  const store = new ProjectionStore()
  store.upsertWorkspace(workspace('ghost'))
  store.upsertSession(session('ghost-session', 'ghost'))
  store.replaceAll([workspace('real')], [session('real-session', 'real')])
  assert.deepEqual(store.workspaces().map((entry) => entry.id), ['real'])
  assert.deepEqual(store.sessions('real').map((entry) => entry.sessionId), ['real-session'])
  // 旧工作区下的会话必须一起消失，否则会留下挂不到任何工作区的孤儿。
  assert.deepEqual(store.sessions('ghost'), [])
  assert.equal(store.size.sessions, 1)
})

test('sessions 按 workspaceId 过滤，且新→旧', () => {
  const store = new ProjectionStore()
  store.upsertSession(session('s1', 'a'))
  store.upsertSession(session('s2', 'b'))
  store.upsertSession(session('s3', 'a'))
  assert.deepEqual(store.sessions('a').map((entry) => entry.sessionId), ['s3', 's1'])
  assert.deepEqual(store.sessions('missing'), [])
})
