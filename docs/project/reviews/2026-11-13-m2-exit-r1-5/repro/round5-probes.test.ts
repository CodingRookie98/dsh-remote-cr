/**
 * R1 #5（第五轮复审）夹具 · 2026-11-13 · M2 出口 · 基线 38c6545
 *
 * 极性（照仓库惯例）：D 系列 —— 断言「缺陷成立」，绿 = 缺陷还在；P 系列 —— 断言「修法成立」。
 *
 * 跑法（仓库根）：
 *   node --test docs/project/reviews/2026-11-13-m2-exit-r1-5/repro/round5-probes.test.ts
 *
 * 只依赖产品代码 + 注入的假连接，不碰真机、不占 3131/8961。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { TeleportError } from '../../../../../src/local/backend/errors.ts'
import type { ProjectionRpc, StreamEvent, StreamHandle } from '../../../../../src/local/projection/remote.ts'
import { ProjectionService, type ConnectTarget } from '../../../../../src/local/projection/service.ts'
import { ProjectionStore } from '../../../../../src/local/projection/store.ts'

const T1: ConnectTarget = { backend: 'ssh', alias: 'gcp', port: 8961, remoteRoot: '/home/hui/workspace' }
const T2: ConnectTarget = { backend: 'ssh', alias: 'gcp-2', port: 8961, remoteRoot: '/home/hui/workspace' }
const T3: ConnectTarget = { backend: 'ssh', alias: 'gcp-3', port: 8961, remoteRoot: '/home/hui/workspace' }
const ATTACH = { remotePath: '/home/hui/workspace', localPath: 'C:/anchor/home/hui/workspace' }
const timers = { schedule: () => 0, cancel: () => {} }

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function workspace(id: string): unknown {
  return {
    workspace: { workspaceId: id, path: '/home/hui/workspace', title: 'w', sessionIds: [], createdAt: '', updatedAt: '' },
    created: true,
  }
}

function cancelled(): TeleportError {
  return new TeleportError({ code: 'remote/cancelled', detail: '已取消这次接入', nextActions: [] })
}

/** 一条可观测的假连接：dispose 计数、disposed 后 rpc 一律失败（模拟真连接被收掉）。 */
interface FakeConn {
  readonly rpc: ProjectionRpc
  readonly disposes: { count: number }
  readonly disposed: { value: boolean }
  rehandshake?(): Promise<void>
  dispose(): void
}

function fakeConn(id: string, options: { gate?: Promise<void>; envPolicy?: string } = {}): FakeConn {
  const disposes = { count: 0 }
  const disposed = { value: false }
  const conn: FakeConn = {
    rpc: {
      call: async <T,>(endpoint: string): Promise<T> => {
        if (disposed.value) {
          throw new TeleportError({ code: 'remote/disconnected', detail: '所用连接已被 dispose', nextActions: [] })
        }
        if (options.gate !== undefined) await options.gate
        if (endpoint === 'workspace/create') return workspace(id) as T
        return { items: [] } as T
      },
      openStream(): StreamHandle {
        const events: StreamEvent[] = []
        return { cancel() {}, async *[Symbol.asyncIterator]() { for (const event of events) yield event } }
      },
    },
    disposes,
    disposed,
    dispose() { disposes.count += 1; disposed.value = true },
    ...(options.envPolicy === undefined ? {} : { envPolicy: options.envPolicy }),
  }
  return conn
}

// ── D7：救援失败 + 取消 ⇒ 已 dispose 的留存连接被回滚塞回 #detached，再接入时复活成 #live ──
// service.ts:556-574 的救援分支失败时 #dropDetached() 已经把这条连接收掉了；finally 的
// `#detached = detachedBefore`（:259）不知道这件事，把**死对象**原样放回槽位。
// 后果：下一次接入把它当「留存连接」救回 #live ⇒ connected=true 但每个 RPC 都报
// remote/disconnected，且不会新建连接（用户只能手动断开才恢复）。
test('D7：救援失败的连接被取消回滚复活成 #live（connected=true 但连接已 dispose）', async () => {
  const store = new ProjectionStore()
  let handshakes = 0
  const a = fakeConn('ws-a')
  Object.defineProperty(a, 'rehandshake', {
    value: async () => { handshakes += 1; if (handshakes === 1) throw new Error('远端进程没了') },
    enumerable: true,
  })
  const gate = deferred<void>()
  let connects = 0
  const service = new ProjectionService({
    store,
    timers,
    async connect() {
      connects += 1
      if (connects === 1) return a as never
      await gate.promise
      throw cancelled()
    },
  })

  await service.attach(T1, ATTACH)
  service.disconnect() // #detached = a（「断开」只留存，不回收）
  assert.equal(service.connected, false)

  const controller = new AbortController()
  const running = service.attach(T1, ATTACH, { signal: controller.signal })
  await tick()
  controller.abort()
  gate.resolve()
  await assert.rejects(running, (error: unknown) => (error as TeleportError).code === 'remote/cancelled')
  assert.equal(a.disposes.count, 1, '前提：救援失败时这条留存连接已经被 #dropDetached() 收掉')

  // 回滚把死对象放回 #detached；再接入时它被当成活连接救回 #live。
  const reused = await service.attach(T1, ATTACH).then(() => null, (error: unknown) => error as TeleportError)
  assert.equal(connects, 2, '没有新建连接：救回的是那个已被 dispose 的对象')
  assert.equal(service.connected, true, 'connected=true，但底下的连接已经 dispose')
  assert.equal(reused?.code, 'remote/disconnected', '此后每个操作都报 remote/disconnected：' + String(reused?.code))
})

// ── D8：一次「已取消」的接入销毁了接入前留存的另一条连接（回滚无法复原）──────────
// #ensure 换 target 时走 disconnect() → #detatch()，而 #detatch 会把**上一条** #detached
// 连接 dispose 掉（service.ts:460-464）。取消后 #detached = detachedBefore 把那个死对象
// 又放回来：用户留存的连接被一次「没成功」的接入收掉，之后还会被 recycle() 再收一次。
test('D8：取消的接入销毁了接入前留存的 #detached 连接，回滚把死对象放回槽位', async () => {
  const store = new ProjectionStore()
  const a = fakeConn('ws-a')
  const b = fakeConn('ws-b')
  const gate = deferred<void>()
  let connects = 0
  const service = new ProjectionService({
    store,
    timers,
    async connect() {
      connects += 1
      if (connects === 1) return a as never
      if (connects === 2) return b as never
      await gate.promise
      throw cancelled()
    },
  })

  await service.attach(T1, ATTACH)      // #live = A
  service.disconnect()                  // #detached = A
  await service.attach(T2, ATTACH)      // #live = B，A 仍在 #detached（两槽同时有值）
  assert.equal(service.connected, true)

  const controller = new AbortController()
  const running = service.attach(T3, ATTACH, { signal: controller.signal })
  await tick()
  controller.abort()
  gate.resolve()
  await assert.rejects(running, (error: unknown) => (error as TeleportError).code === 'remote/cancelled')

  assert.equal(b.disposes.count, 0, 'B 是接入前的 #live，回滚后仍是 #live，没被收')
  assert.equal(a.disposes.count, 1, '一次「已取消」的接入把用户留存的 A 收掉了')
  service.recycle()
  assert.equal(a.disposes.count, 2, '回滚又把已 dispose 的 A 放回 #detached，recycle 再收它一次')
})

// ── D9：#lastTarget 没回滚 ⇒ 取消后的「重连」指向被取消的那个目标 ──────────────
test('D9：取消后 #lastTarget 仍是被取消的 T2，断开后 target 变成 T2', async () => {
  const store = new ProjectionStore()
  const a = fakeConn('ws-a')
  const b = fakeConn('ws-b', { gate: deferred<void>().promise })
  let connects = 0
  const service = new ProjectionService({
    store,
    timers,
    async connect() {
      connects += 1
      return (connects === 1 ? a : b) as never
    },
  })

  await service.attach(T1, ATTACH)
  assert.deepEqual(service.snapshot().target, T1)

  const gate = deferred<void>()
  ;(b.rpc as unknown as { call: unknown }).call = async <T,>(endpoint: string): Promise<T> => {
    if (endpoint === 'workspace/create') { await gate.promise; return workspace('ws-b') as T }
    return { items: [] } as T
  }
  const controller = new AbortController()
  const running = service.attach(T2, ATTACH, { signal: controller.signal })
  await tick()
  controller.abort()
  gate.resolve()
  await assert.rejects(running, (error: unknown) => (error as TeleportError).code === 'remote/cancelled')

  assert.deepEqual(service.snapshot().target, T1, '连着的时候仍报 A')
  service.disconnect()
  assert.deepEqual(service.snapshot().target, T2, '回滚没还原 #lastTarget：重连会连到被取消的 T2')
})

// ── P7：接入前没有 #detached 时，回滚让 A 恰好回到 #live 的唯一位置 ──────────────
test('P7：换 target 取消后 A 只在 #live 里，recycle 只收它一次（B1 的正面）', async () => {
  const store = new ProjectionStore()
  const a = fakeConn('ws-a')
  const b = fakeConn('ws-b')
  const gate = deferred<void>()
  let connects = 0
  const service = new ProjectionService({
    store,
    timers,
    async connect() {
      connects += 1
      if (connects === 1) return a as never
      return { ...b, rpc: ((): ProjectionRpc => ({
        call: async <T,>(endpoint: string): Promise<T> => {
          if (endpoint === 'workspace/create') { await gate.promise; return workspace('ws-b') as T }
          return { items: [] } as T
        },
        openStream(): StreamHandle {
          const events: StreamEvent[] = []
          return { cancel() {}, async *[Symbol.asyncIterator]() { for (const event of events) yield event } }
        },
      }))() } as never
    },
  })

  await service.attach(T1, ATTACH)
  const controller = new AbortController()
  const running = service.attach(T2, ATTACH, { signal: controller.signal })
  await tick()
  controller.abort()
  gate.resolve()
  await assert.rejects(running, (error: unknown) => (error as TeleportError).code === 'remote/cancelled')

  assert.equal(service.connected, true)
  assert.equal(a.disposes.count, 0)
  service.recycle()
  assert.equal(a.disposes.count, 1, 'A 只被收一次：回滚没有把它留在两个槽位里')
})

// ── P8：收尾窗口观测 —— #attach 先清，dispose 仍可能在跑 ────────────────────────
test('P8：dispose 未落定时 attachProgress 已经清空（面板在窗口内看不到阶段）', async () => {
  const store = new ProjectionStore()
  const gate = deferred<void>()
  const disposeGate = deferred<void>()
  const service = new ProjectionService({
    store,
    timers,
    async connect() {
      return {
        rpc: {
          call: async <T,>(endpoint: string): Promise<T> => {
            if (endpoint === 'workspace/create') { await gate.promise; return workspace('ws') as T }
            return { items: [] } as T
          },
          openStream(): StreamHandle {
            const events: StreamEvent[] = []
            return { cancel() {}, async *[Symbol.asyncIterator]() { for (const event of events) yield event } }
          },
        },
        async dispose() { await disposeGate.promise; return true },
      } as never
    },
  })

  const controller = new AbortController()
  let settled = false
  const running = service.attach(T1, ATTACH, { signal: controller.signal }).then(() => { settled = true }, () => { settled = true })
  await tick()
  controller.abort()
  gate.resolve()
  await tick()
  await tick()
  assert.equal(service.attachProgress, null, '#attach 已清（B2 的修复）')
  assert.equal(settled, false, '但 /attach 这个 Promise 还挂着：等 dispose 收尾')
  disposeGate.resolve()
  await running
})
