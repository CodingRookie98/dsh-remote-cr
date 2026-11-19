import assert from 'node:assert/strict'
import test from 'node:test'

import { ProjectionHub, sameHostOf, targetKeyOf } from './hub.ts'
import { ProjectionService, sameTarget, type ConnectTarget } from './service.ts'
import { ProjectionStore } from './store.ts'
import type { ProjectionRpc, StreamEvent, StreamHandle } from './remote.ts'

const A: ConnectTarget = { backend: 'ssh', alias: 'a', port: 8941, remoteRoot: '/home/hui/a' }
const B: ConnectTarget = { backend: 'ssh', alias: 'b', port: 8942, remoteRoot: '/home/hui/b' }

/**
 * 假远端：`workspace/create` 按 remotePath 生成稳定的 workspaceId，
 * 这样「同一路径接两次」是幂等的（一个工作区）、「不同路径」是两个工作区。
 */
/** `failPaths` 里的路径会让 `workspace/create` 抛错（用来造「已有工作区时再次失败」）。 */
function fakeConnect(failPaths: Set<string> = new Set()): { rpc: ProjectionRpc; dispose(): void } {
  return {
    rpc: {
      async call<T>(endpoint: string, payload: unknown): Promise<T> {
        if (endpoint === 'workspace/create') {
          // 真实形状：`{ args: { request: { path } } }`。
          const path =
            (payload as { args?: { request?: { path?: string } } }).args?.request?.path ?? '/x'
          if (failPaths.has(path)) throw new Error('workspace/create boom')
          return { workspace: { workspaceId: 'ws:' + path, path, title: path, sessionIds: [], createdAt: '', updatedAt: '' }, created: true } as T
        }
        return { items: [] } as T
      },
      openStream(): StreamHandle {
        const events: StreamEvent[] = []
        return { cancel() {}, async *[Symbol.asyncIterator]() { for (const event of events) yield event } }
      },
    },
    dispose() {}
  }
}

function hubWith(): ProjectionHub {
  return new ProjectionHub(
    () =>
      new ProjectionService({
        store: new ProjectionStore(),
        connect: async () => fakeConnect(),
      }),
  )
}

const LOCAL = 'C:/anchors/x'

test('两个 target 各得一个引擎，投影互不覆盖（R1）', async () => {
  const hub = hubWith()
  await hub.attach(A, { remotePath: '/home/hui/a', localPath: LOCAL })
  await hub.attach(B, { remotePath: '/home/hui/b', localPath: LOCAL })
  assert.equal(hub.size, 2)
  assert.deepEqual(hub.snapshotOf(A)?.workspaces.map((w) => w.id), ['ws:/home/hui/a'])
  assert.deepEqual(hub.snapshotOf(B)?.workspaces.map((w) => w.id), ['ws:/home/hui/b'])
  assert.equal(hub.focused()?.snapshot().workspaces[0]?.id, 'ws:/home/hui/b', 'focus = 最近 attach 的那台')
})

test('同一 target 复用同一个引擎实例（R2）', async () => {
  const hub = hubWith()
  const first = hub.serviceFor(A)
  await hub.attach(A, { remotePath: '/home/hui/a', localPath: LOCAL })
  await hub.attach(A, { remotePath: '/home/hui/a', localPath: LOCAL })
  assert.equal(hub.size, 1)
  assert.equal(hub.peek(A), first, '第二次 attach 必须还是同一个实例')
  assert.equal(hub.snapshotOf(A)?.workspaces.length, 1, '同一路径接两次不该多出一条工作区')
})

test('peek 不建引擎：从没接过的 target 返回 undefined（A1 的「只查不建」）', () => {
  const hub = hubWith()
  assert.equal(hub.peek(A), undefined)
  assert.equal(hub.size, 0)
  assert.deepEqual(hub.entries(), [])
})

test('disposeAll 级联且幂等（R5）', async () => {
  const hub = hubWith()
  await hub.attach(A, { remotePath: '/home/hui/a', localPath: LOCAL })
  await hub.attach(B, { remotePath: '/home/hui/b', localPath: LOCAL })
  hub.disposeAll()
  assert.equal(hub.size, 0)
  assert.equal(hub.focused(), null)
  hub.disposeAll()
})

test('A3 端口分配：同主机同端口的第二个 target 自动顺延（不撞 remote/port-in-use）', async () => {
  const hub = hubWith()
  await hub.attach(A, { remotePath: '/home/hui/a', localPath: LOCAL })
  const A2 = { ...A, remoteRoot: '/home/hui/a2' }
  await hub.attach(A2, { remotePath: '/home/hui/a2', localPath: LOCAL })
  const entries = hub.entries()
  assert.equal(entries.length, 2)
  assert.notEqual(entries[0]?.effective.port, entries[1]?.effective.port, '两个引擎不能拿同一个端口')
  assert.equal(entries[1]?.portAdjusted, true, '第二个应当标出「端口被顺延过」')
})

test('references = 投影里的工作区数（不是 attach 次数）', async () => {
  const hub = hubWith()
  await hub.attach(A, { remotePath: '/home/hui/a', localPath: LOCAL })
  assert.equal(hub.entries()[0]?.references, 1)
  // 同一路径再接一次是幂等的：工作区还是一个，引用数不该涨。
  await hub.attach(A, { remotePath: '/home/hui/a', localPath: LOCAL })
  assert.equal(hub.entries()[0]?.references, 1, '重复接入不该让 references 虚高')
  // 换一个路径接入 → 第二个工作区。
  await hub.attach(A, { remotePath: '/home/hui/a/other', localPath: LOCAL })
  assert.equal(hub.entries()[0]?.references, 2)
})

test('移走最后一个工作区后 releaseAll 才回收这台', async () => {
  const hub = hubWith()
  await hub.attach(A, { remotePath: '/home/hui/a', localPath: LOCAL })
  await hub.attach(A, { remotePath: '/home/hui/a/other', localPath: LOCAL })
  const service = hub.peek(A)
  assert.ok(service !== undefined)
  assert.equal(service.removeWorkspace('ws:/home/hui/a'), true)
  assert.equal(hub.entries()[0]?.references, 1, '还有一个工作区：这台不能回收')
  assert.equal(service.removeWorkspace('ws:/home/hui/a/other'), true)
  assert.deepEqual(await hub.releaseAll(A), { released: 0, recycled: true })
  assert.equal(hub.entries().length, 0)
})

test('B3 attach 失败回滚：失败一次 + 成功一次 → 一次 releaseAll 即回收', async () => {
  let failNext = true
  const hub = new ProjectionHub(
    () =>
      new ProjectionService({
        store: new ProjectionStore(),
        connect: async () => {
          if (failNext) {
            failNext = false
            throw Object.assign(new Error('boom'), { code: 'remote/bootstrap-failed' })
          }
          return fakeConnect()
        },
      }),
  )
  await assert.rejects(hub.attach(A, { remotePath: '/home/hui/a', localPath: LOCAL }))
  assert.equal(hub.entries().length, 0, '失败的 attach 不该留下 entry / 端口')
  await hub.attach(A, { remotePath: '/home/hui/a', localPath: LOCAL })
  assert.deepEqual(await hub.releaseAll(A), { released: 1, recycled: true }, '一次就回收（没有留账）')
})

test('B3 边界：已有工作区时，失败不得删掉 entry（否则在用引用被孤儿化）', async () => {
  // 失败必须来自「已有连接上的这次调用」，而不是 connect：已连之后再 attach 不会重连。
  const failPaths = new Set<string>()
  const hub = new ProjectionHub(
    () =>
      new ProjectionService({
        store: new ProjectionStore(),
        connect: async () => fakeConnect(failPaths),
      }),
  )
  await hub.attach(A, { remotePath: '/home/hui/a', localPath: LOCAL })
  failPaths.add('/home/hui/a/2')
  await assert.rejects(hub.attach(A, { remotePath: '/home/hui/a/2', localPath: LOCAL }))
  assert.equal(hub.entries().length, 1, '还有 1 个工作区在用，entry 必须留着')
  assert.equal(hub.entries()[0]?.references, 1)
})

test('N4 失败接入不清掉已连主机的读目标', async () => {
  let fail = false
  const hub = new ProjectionHub(
    () =>
      new ProjectionService({
        store: new ProjectionStore(),
        connect: async () => {
          if (fail) throw new Error('boom')
          return fakeConnect()
        },
      }),
  )
  await hub.attach(A, { remotePath: '/home/hui/a', localPath: LOCAL })
  const focusedBefore = hub.focused()
  fail = true
  await assert.rejects(hub.attach({ ...A, remoteRoot: '/other' }, { remotePath: '/o', localPath: LOCAL }))
  assert.equal(hub.focused(), focusedBefore, '失败不能把已连主机从默认读路径上抹掉')
})

test('M7 端口归还：21 台同时在场 → 全部结束时端口全部归还（第二轮仍能分配）', async () => {
  let disposed = 0
  const hub = new ProjectionHub(
    () =>
      ({
        attach: async () => ({ created: true, workspace: {}, sessions: [] }),
        recycle() {},
        dispose: () => {
          disposed += 1
        },
        removeWorkspace: () => true,
        snapshot: () => ({ workspaces: [{}], sessions: [], connected: false, target: null, link: 'idle', envPolicy: null, attach: null, stale: false }),
        get connected() {
          return false
        },
      }) as unknown as ProjectionService,
  )
  const first = Array.from({ length: 21 }, (_, index) => ({ ...A, remoteRoot: '/sim-' + String(index) }))
  for (const target of first) await hub.attach(target, { remotePath: '/a', localPath: LOCAL })
  const ports = hub.entries().map((entry) => entry.effective.port)
  assert.equal(ports.length, 21)
  assert.equal(new Set(ports).size, 21, '21 台必须拿到 21 个不同端口')
  for (const target of first) await hub.releaseAll(target)
  assert.equal(hub.entries().length, 0)
  const again = Array.from({ length: 21 }, (_, index) => ({ ...A, remoteRoot: '/again-' + String(index) }))
  for (const target of again) await hub.attach(target, { remotePath: '/a', localPath: LOCAL })
  assert.equal(hub.entries().length, 21, '第二轮同样能拿满 21 个（端口都归还了）')
  assert.equal(disposed, 0)
})

test('N7 只建过引擎（0 个工作区）的僵尸：releaseAll 要删 entry 并归还端口', async () => {
  const hub = hubWith()
  hub.serviceFor(A)
  assert.equal(hub.entries().length, 1)
  assert.equal(hub.entries()[0]?.references, 0)
  assert.deepEqual(await hub.releaseAll(A), { released: 0, recycled: true })
  assert.equal(hub.entries().length, 0)
})

test('recycle 抛错也必须删 entry（否则端口与引用永久卡死）', async () => {
  const hub = new ProjectionHub(
    () =>
      ({
        attach: async () => ({ created: true, workspace: {}, sessions: [] }),
        recycle: () => {
          throw new Error('recycle boom')
        },
        dispose() {},
        snapshot: () => ({ workspaces: [], sessions: [], connected: false, target: null, link: 'idle', envPolicy: null, attach: null, stale: false }),
      }) as unknown as ProjectionService,
  )
  await hub.attach(A, { remotePath: '/a', localPath: LOCAL })
  // 回收失败要**抛出去**（P4 P1-2），但 entry 与端口仍必须收回——否则端口永久被算作占用。
  await assert.rejects(() => hub.releaseAll(A), /recycle boom/)
  assert.equal(hub.entries().length, 0)
})

test('recycle 是异步的：releaseAll 会等它结束（不再「先 resolved 再删远端」）', async () => {
  let finished = false
  const hub = new ProjectionHub(
    () =>
      ({
        attach: async () => ({ created: true, workspace: {}, sessions: [] }),
        recycle: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20))
          finished = true
        },
        dispose() {},
        snapshot: () => ({ workspaces: [{}], sessions: [], connected: false, target: null, link: 'idle', envPolicy: null, attach: null, stale: false }),
      }) as unknown as ProjectionService,
  )
  await hub.attach(A, { remotePath: '/a', localPath: LOCAL })
  await hub.releaseAll(A)
  assert.equal(finished, true, 'releaseAll 返回时 recycle 必须已经结束')
})

test('targetKeyOf / sameHostOf / sameTarget：端口、目录、大小写', () => {
  assert.equal(targetKeyOf(A), targetKeyOf({ ...A }))
  assert.equal(targetKeyOf(A), targetKeyOf({ ...A, alias: 'A' }), 'SSH 别名大小写归一')
  assert.notEqual(targetKeyOf(A), targetKeyOf({ ...A, port: 9999 }))
  assert.notEqual(targetKeyOf(A), targetKeyOf({ ...A, remoteRoot: '/home/hui/other' }))
  assert.equal(sameTarget(A, { ...A, alias: 'A' }), true, 'sameTarget 也要大小写不敏感（与键对齐）')
  assert.equal(sameHostOf(A, { ...A, port: 9999, remoteRoot: '/other' }), true)
  assert.equal(sameHostOf(A, { ...A, alias: 'A' }), true)
  assert.equal(
    sameHostOf(
      { backend: 'wsl', distro: 'Ubuntu-24.04', port: 1, remoteRoot: '/a' },
      { backend: 'wsl', distro: 'ubuntu-24.04', port: 2, remoteRoot: '/b' },
    ),
    true,
  )
  assert.equal(sameHostOf(A, { backend: 'wsl', distro: 'a', port: 8941, remoteRoot: '/a' }), false, '跨后端判不出同机（保守方向）')
})
