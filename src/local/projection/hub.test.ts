import assert from 'node:assert/strict'
import test from 'node:test'

import { ProjectionHub, sameHostOf, targetKeyOf } from './hub.ts'
import { ProjectionService, type ConnectTarget } from './service.ts'
import { ProjectionStore } from './store.ts'
import type { ProjectionRpc, StreamEvent, StreamHandle } from './remote.ts'

const A: ConnectTarget = { backend: 'ssh', alias: 'a', port: 8941, remoteRoot: '/home/hui/a' }
const B: ConnectTarget = { backend: 'ssh', alias: 'b', port: 8942, remoteRoot: '/home/hui/b' }

/** 一台会报出自己 workspaceId 的假远端：用来区分「两个引擎是不是各存各的」。 */
function fakeConnect(workspaceId: string) {
  return async (): Promise<{ rpc: ProjectionRpc; dispose(): void }> => ({
    rpc: {
      async call<T>(endpoint: string): Promise<T> {
        if (endpoint === 'workspace/create') {
          return {
            workspace: { workspaceId, path: '/home/hui/x', title: 'x', sessionIds: [], createdAt: '', updatedAt: '' },
            created: true,
          } as T
        }
        return { items: [] } as T
      },
      openStream(): StreamHandle {
        const events: StreamEvent[] = []
        return { cancel() {}, async *[Symbol.asyncIterator]() { for (const event of events) yield event } }
      },
    },
    dispose() {}
  })
}

function hubWith(ids: Record<string, string>): ProjectionHub {
  return new ProjectionHub(() => {
    const store = new ProjectionStore()
    let counter = 0
    return new ProjectionService({
      store,
      connect: async (target) => {
        counter += 1
        const key = target.backend === 'ssh' ? target.alias : target.distro
        const connect = fakeConnect(ids[key] ?? 'ws-' + String(counter))
        return await connect()
      },
    })
  })
}

test('两个 target 各得一个引擎，投影互不覆盖（R1）', async () => {
  const hub = hubWith({ a: 'ws-a', b: 'ws-b' })
  await hub.attach(A, { remotePath: '/home/hui/a', localPath: 'C:/anchors/a' })
  await hub.attach(B, { remotePath: '/home/hui/b', localPath: 'C:/anchors/b' })
  assert.equal(hub.size, 2)
  assert.deepEqual(hub.snapshotOf(A)?.workspaces.map((w) => w.id), ['ws-a'])
  assert.deepEqual(hub.snapshotOf(B)?.workspaces.map((w) => w.id), ['ws-b'])
  assert.equal(hub.focused()?.snapshot().workspaces[0]?.id, 'ws-b', 'focus = 最近 attach 的那台')
})

test('同一 target 复用同一个引擎实例（R2）', async () => {
  const hub = hubWith({ a: 'ws-a' })
  const first = hub.serviceFor(A)
  await hub.attach(A, { remotePath: '/home/hui/a', localPath: 'C:/anchors/a' })
  await hub.attach(A, { remotePath: '/home/hui/a', localPath: 'C:/anchors/a' })
  assert.equal(hub.size, 1)
  assert.equal(hub.peek(A), first, '第二次 attach 必须还是同一个实例')
  assert.equal(hub.snapshotOf(A)?.workspaces.length, 1, '两次 attach 不该多出一条工作区')
})

test('peek 不建引擎：从没接过的 target 返回 undefined（A1 的「只查不建」）', () => {
  const hub = hubWith({})
  assert.equal(hub.peek(A), undefined)
  assert.equal(hub.size, 0)
  assert.deepEqual(hub.entries(), [])
})

test('disposeAll 级联且幂等（R5）', async () => {
  const hub = hubWith({ a: 'ws-a', b: 'ws-b' })
  await hub.attach(A, { remotePath: '/home/hui/a', localPath: 'C:/anchors/a' })
  await hub.attach(B, { remotePath: '/home/hui/b', localPath: 'C:/anchors/b' })
  hub.disposeAll()
  assert.equal(hub.size, 0)
  assert.equal(hub.focused(), null)
  hub.disposeAll()
})

test('A3 端口分配：同主机同端口的第二个 target 自动顺延（不撞 remote/port-in-use）', async () => {
  const hub = hubWith({ a: 'ws-a' })
  await hub.attach(A, { remotePath: '/home/hui/a', localPath: 'C:/anchors/a' })
  // 同一 alias、同一端口、不同目录：真实世界里这就是「同一台机器的另一个工作区」。
  const A2 = { ...A, remoteRoot: '/home/hui/a2' }
  await hub.attach(A2, { remotePath: '/home/hui/a2', localPath: 'C:/anchors/a2' })
  const entries = hub.entries()
  assert.equal(entries.length, 2)
  const ports = entries.map((entry) => entry.effective.port)
  assert.notEqual(ports[0], ports[1], '两个引擎不能拿同一个端口')
  assert.equal(entries[1]?.portAdjusted, true, '第二个应当标出「端口被顺延过」')
})

test('A3 引用计数：两个引用释放一个不回收，最后一个才 recycle', async () => {
  let recycles = 0
  const hub = new ProjectionHub(() => {
    const service = new ProjectionService({
      store: new ProjectionStore(),
      connect: async () => await fakeConnect('ws-a')(),
    })
    const original = service.recycle.bind(service)
    service.recycle = () => {
      recycles += 1
      original()
    }
    return service
  })
  await hub.attach(A, { remotePath: '/home/hui/a', localPath: 'C:/anchors/a' })
  await hub.attach(A, { remotePath: '/home/hui/a', localPath: 'C:/anchors/a' })
  assert.equal(hub.entries()[0]?.references, 2)
  assert.deepEqual(hub.release(A), { remaining: 1, recycled: false })
  assert.equal(recycles, 0, '还有一个引用，不许回收')
  assert.deepEqual(hub.release(A), { remaining: 0, recycled: true })
  assert.equal(recycles, 1)
  // B4：回收后 entry 必须被删掉（否则僵尸端口会让池假满）；投影由下一次 attach 重建。
  assert.equal(hub.entries().length, 0)
  assert.equal(hub.peek(A), undefined)
})

test('A3 释放未知 target 不抛、也不误报回收', () => {
  const hub = hubWith({})
  assert.deepEqual(hub.release(A), { remaining: 0, recycled: false })
})

/** 一个只实现 hub 会调到的几个方法的假 service（B3/B4 只需要 attach/recycle/dispose）。 */
function stubService(attach?: () => Promise<unknown>): ProjectionService {
  return {
    attach: attach ?? (async () => ({ created: true, workspace: {}, sessions: [] })),
    recycle() {},
    dispose() {},
    snapshot: () => ({ workspaces: [], sessions: [], connected: false, target: null, link: 'idle', envPolicy: null, attach: null, stale: false }),
    get connected() {
      return false
    },
  } as unknown as ProjectionService
}

test('B3 attach 失败回滚：失败一次 + 成功一次 → 一次 release 即回收', async () => {
  let failNext = true
  const hub = new ProjectionHub(() =>
    stubService(async () => {
      if (failNext) {
        failNext = false
        throw new Error('boom')
      }
      return { created: true, workspace: {}, sessions: [] }
    }),
  )
  await assert.rejects(hub.attach(A, { remotePath: '/a', localPath: 'C:/a' }))
  assert.equal(hub.entries().length, 0, '失败的 attach 不该留下 entry / 端口')
  await hub.attach(A, { remotePath: '/a', localPath: 'C:/a' })
  assert.deepEqual(hub.release(A), { remaining: 0, recycled: true }, '一次 release 就该回收（引用没有留账）')
})

test('B3 边界：还有别的引用时，失败不得删掉 entry（否则在用引用被孤儿化）', async () => {
  let failNext = false
  const hub = new ProjectionHub(() =>
    stubService(async () => {
      if (failNext) throw new Error('boom')
      return { created: true, workspace: {}, sessions: [] }
    }),
  )
  await hub.attach(A, { remotePath: '/a', localPath: 'C:/a' })
  failNext = true
  await assert.rejects(hub.attach(A, { remotePath: '/a', localPath: 'C:/a' }))
  assert.equal(hub.entries().length, 1, '还有 1 个引用在用，entry 必须留着')
  assert.equal(hub.entries()[0]?.references, 1)
  assert.notEqual(hub.peek(A), undefined)
})

test('B4 变体：drop 时必须还端口（否则第二轮会假池满）', async () => {
  const hub = new ProjectionHub(() => stubService())
  for (let round = 0; round < 2; round += 1) {
    for (let index = 0; index < 21; index += 1) {
      const target = { ...A, remoteRoot: '/r' + String(round) + '-' + String(index) }
      await hub.attach(target, { remotePath: '/a', localPath: 'C:/a' })
      hub.release(target)
    }
    assert.equal(hub.entries().length, 0)
  }
})

test('B4 端口不随僵尸条目泄漏：21 次 attach+release 后第 22 个仍能分配', async () => {
  let made = 0
  const hub = new ProjectionHub(() => {
    made += 1
    return stubService()
  })
  for (let index = 0; index < 21; index += 1) {
    const target = { ...A, remoteRoot: '/home/hui/w' + String(index) }
    await hub.attach(target, { remotePath: '/a', localPath: 'C:/a' })
    hub.release(target)
  }
  assert.equal(hub.entries().length, 0, '释放后不留 entry')
  const extra = { ...A, remoteRoot: '/home/hui/w-last' }
  await hub.attach(extra, { remotePath: '/a', localPath: 'C:/a' })
  assert.equal(hub.entries().length, 1, '第 22 个不该被假池满挡住')
  assert.ok(made >= 22)
})

test('sameHostOf：WSL 与 SSH 别名都大小写不敏感（P4 B6）', () => {
  assert.equal(sameHostOf(A, { ...A, port: 9999, remoteRoot: '/other' }), true, '同 alias 不同端口/目录仍是同一台主机')
  assert.equal(sameHostOf(A, { ...A, alias: 'A' }), true, 'SSH 别名大小写不该当成两台机器')
  assert.equal(
    sameHostOf(
      { backend: 'wsl', distro: 'Ubuntu-24.04', port: 1, remoteRoot: '/a' },
      { backend: 'wsl', distro: 'ubuntu-24.04', port: 2, remoteRoot: '/b' },
    ),
    true,
  )
  assert.equal(sameHostOf(A, { backend: 'wsl', distro: 'a', port: 8941, remoteRoot: '/a' }), false, '跨后端判不出同机（保守方向）')
})

test('targetKeyOf 与 sameTarget 同形：端口/检出根不同就是不同键', () => {
  assert.equal(targetKeyOf(A), targetKeyOf({ ...A }))
  assert.notEqual(targetKeyOf(A), targetKeyOf({ ...A, port: 9999 }))
  assert.notEqual(targetKeyOf(A), targetKeyOf({ ...A, remoteRoot: '/home/hui/other' }))
})
