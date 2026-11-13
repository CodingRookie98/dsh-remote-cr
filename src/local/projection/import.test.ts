import assert from 'node:assert/strict'
import test from 'node:test'

import { parseBaselineFrame, planImport } from './import.ts'

const row = (id: string, path: string): unknown => ({ workspaceId: id, path, title: path.split('/').pop() ?? path, sessionIds: [], createdAt: '', updatedAt: '' })

test('parseBaselineFrame：baseline 的 items 解析成行，坏条目跳过', () => {
  const rows = parseBaselineFrame({
    type: 'baseline',
    value: { items: [row('w1', '/home/hui/workspace'), { workspaceId: 'w2' }, row('w3', '/srv/app')], archivedSessionIds: [], pinnedSessionIds: [] },
  })
  assert.deepEqual(rows.map((item) => item.workspaceId), ['w1', 'w3'])
  assert.equal(rows[0]?.path, '/home/hui/workspace')
})

test('parseBaselineFrame：不是 baseline / 缺 items 一律空（宁缺勿错）', () => {
  assert.deepEqual(parseBaselineFrame({ type: 'upsert', workspace: row('w1', '/a') }), [])
  assert.deepEqual(parseBaselineFrame({ type: 'baseline', value: {} }), [])
  assert.deepEqual(parseBaselineFrame(null), [])
})

test('planImport：本地已有的按 id 与路径双重跳过', () => {
  const rows = [
    { workspaceId: 'w1', path: '/a', title: 'a' },
    { workspaceId: 'w2', path: '/b', title: 'b' },
    { workspaceId: 'w3', path: '/c', title: 'c' },
  ]
  const planned = planImport(rows, [{ workspaceId: 'w1' }, { remotePath: '/b' }])
  assert.deepEqual(planned.candidates.map((item) => item.workspaceId), ['w3'])
  assert.equal(planned.skipped, 2)
})

test('planImport：远端两条同路径只导一条（侧栏不出现重复卡片）', () => {
  const rows = [
    { workspaceId: 'w1', path: '/a', title: 'a' },
    { workspaceId: 'w2', path: '/a', title: 'a2' },
  ]
  const planned = planImport(rows, [])
  assert.equal(planned.candidates.length, 1)
  assert.equal(planned.skipped, 1)
})
