import assert from 'node:assert/strict'
import test from 'node:test'

import type { RemoteTargetInfo } from '../shared/api.ts'
import { workspaceMenuActions, workspaceMenuContribution, type WorkspaceMenuTarget } from './workspace-menu.ts'

const TARGET: RemoteTargetInfo = { backend: 'wsl', distro: 'ubuntu_dev', port: 8899, remoteRoot: '/home/dev/harness' }
const WORKSPACE: WorkspaceMenuTarget = { workspaceId: 'ws-1', path: '/home/hui/proj', displayTitle: 'proj' }
const LABELS = { reconnect: '重连', disconnect: '断开', stop: '结束远端' }

function handlers(calls: string[]) {
  return {
    reconnect: async () => { calls.push('reconnect') },
    disconnect: async () => { calls.push('disconnect') },
    stop: async () => { calls.push('stop') },
  }
}

test('不是我们投影的工作区：一个动作都不给（别人的行菜单保持原样）', () => {
  const snapshot = { connected: true, target: TARGET, workspaces: [{ localPath: '/elsewhere' }] }
  assert.deepEqual(workspaceMenuActions(WORKSPACE, snapshot, LABELS, handlers([])), [])
  assert.deepEqual(workspaceMenuActions(WORKSPACE, null, LABELS, handlers([])), [])
  assert.deepEqual(
    workspaceMenuActions(WORKSPACE, { connected: false, target: null, workspaces: [{ localPath: WORKSPACE.path }] }, LABELS, handlers([])),
    [],
    '没连过就不知道该操作哪台远端，宁可不给项',
  )
})

test('已连接：重连 / 断开 / 结束远端 三项，危险项在最后并带分隔线', () => {
  const snapshot = { connected: true, target: TARGET, workspaces: [{ localPath: WORKSPACE.path }] }
  const actions = workspaceMenuActions(WORKSPACE, snapshot, LABELS, handlers([]))
  assert.deepEqual(actions.map((action) => action.id), ['remote-cr.reconnect', 'remote-cr.disconnect', 'remote-cr.stop'])
  assert.deepEqual(actions.map((action) => action.label), ['重连', '断开', '结束远端'])
  assert.equal(actions[2]?.danger, true)
  assert.equal(actions[2]?.separatorBefore, true)
  assert.equal(actions[0]?.danger, undefined)
})

test('离线：不提供「断开」（已经断了），重连与结束远端仍在', () => {
  const snapshot = { connected: false, target: TARGET, workspaces: [{ localPath: WORKSPACE.path }] }
  assert.deepEqual(
    workspaceMenuActions(WORKSPACE, snapshot, LABELS, handlers([])).map((action) => action.id),
    ['remote-cr.reconnect', 'remote-cr.stop'],
  )
})

test('动作真的打到那台远端，不是面板的 focus', async () => {
  const calls: string[] = []
  const snapshot = { connected: true, target: TARGET, workspaces: [{ localPath: WORKSPACE.path }] }
  const actions = workspaceMenuActions(WORKSPACE, snapshot, LABELS, handlers(calls))
  for (const action of actions) await action.run?.()
  assert.deepEqual(calls, ['reconnect', 'disconnect', 'stop'])
})

test('贡献体的 resolve 在快照读取失败时退回空数组（断线不该变成菜单报错）', async () => {
  const contribution = workspaceMenuContribution({
    snapshot: async () => {
      throw new Error('offline')
    },
    labels: LABELS,
    handlers: handlers([]),
  })
  assert.deepEqual(await contribution.resolve(WORKSPACE), [])
  assert.equal(contribution.target, 'workspace')
})
