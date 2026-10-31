/**
 * 投影服务的连接生命周期（P3.5.1）。
 *
 * 这里锁的是 **断线语义**，不是网络本身：用假 `connect` + 假定时器，精确断言
 * 「传输层失败 → 标 offline 并进入 retrying → 定时器到点后连回来并重建投影表」。
 * 真机上的断线（杀隧道 / 重启远端）由 `spikes/m1/cross-machine-t6/probe.cjs` 取证。
 *
 * 一条刻意的边界：**业务拒绝不触发重连**。远端把某次 RPC 拒了是结论，不是故障；
 * 对它重连一万次还是同一个拒绝，只会把面板卡在「正在重试」上骗用户。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { TeleportError } from '../backend/errors.ts'
import type { ProjectionRpc, StreamEvent, StreamHandle } from './remote.ts'
import { ProjectionService, type ConnectTarget } from './service.ts'
import { ProjectionStore } from './store.ts'
import type { ReconnectTimers } from '../../shared/reconnect.ts'

const TARGET: ConnectTarget = {
  distro: 'ubuntu_dev',
  port: 8899,
  remoteRoot: '/home/dev/harness',
}

/** 假定时器：只记账不睡，由测试手动推进（与 `shared/reconnect.test.ts` 同构）。 */
function fakeTimers(): ReconnectTimers & { pending(): number[]; flush(): Promise<void> } {
  const entries: Array<{ delayMs: number; run: () => void }> = []
  return {
    schedule(delayMs, run) {
      entries.push({ delayMs, run })
      return entries.length - 1
    },
    cancel(handle) {
      const index = handle as number
      if (entries[index] !== undefined) entries[index] = { delayMs: Number.NaN, run: () => {} }
    },
    pending() {
      return entries.filter((entry) => !Number.isNaN(entry.delayMs)).map((entry) => entry.delayMs)
    },
    async flush() {
      let next = entries.shift()
      while (next !== undefined && Number.isNaN(next.delayMs)) next = entries.shift()
      if (next === undefined) return
      next.run()
      // 让 #fire 里的 promise 链跑完
      await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

interface FakeRpc extends ProjectionRpc {
  readonly calls: string[]
  /** 下一次 `call` 抛什么；消费一次后自动清除。 */
  failNext(error: unknown): void
}

/** 假 RPC：记住被调过的端点，回最小可解析形状。 */
function fakeRpc(): FakeRpc {
  const calls: string[] = []
  const errors: unknown[] = []
  return {
    calls,
    failNext(error) {
      errors.push(error)
    },
    async call<T>(endpoint: string): Promise<T> {
      calls.push(endpoint)
      const error = errors.shift()
      if (error !== undefined) throw error
      if (endpoint === 'workspace/create') {
        return {
          workspace: {
            workspaceId: 'ws-1',
            path: TARGET.remoteRoot,
            title: 'harness',
            sessionIds: [],
            createdAt: '',
            updatedAt: '',
          },
          created: true,
        } as T
      }
      if (endpoint === 'session/list') return { items: [] } as T
      if (endpoint === 'session/create') return { sessionId: 'sess-1' } as T
      throw new Error('假的 RPC 没有准备 ' + endpoint)
    },
    openStream(): StreamHandle {
      const events: StreamEvent[] = []
      return {
        cancel() {},
        async *[Symbol.asyncIterator]() {
          for (const event of events) yield event
        },
      }
    },
  }
}

function transportLoss(): TeleportError {
  return new TeleportError({
    code: 'remote/tunnel-unavailable',
    detail: 'RPC workspace/create 在 30s 内没有完成：socket hang up',
    nextActions: ['等隧道恢复后重试'],
  })
}

interface Rig {
  readonly service: ProjectionService
  readonly store: ProjectionStore
  readonly rpc: FakeRpc
  readonly timers: ReturnType<typeof fakeTimers>
  /** 每次 `connect` 被调用都记一笔，便于断言「重连确实重新握手了」。 */
  readonly connects: ConnectTarget[]
  /** 让后续 `connect` 失败。 */
  failConnect(error: unknown): void
}

function rig(): Rig {
  const store = new ProjectionStore()
  const rpc = fakeRpc()
  const timers = fakeTimers()
  const connects: ConnectTarget[] = []
  let connectError: unknown = undefined
  const service = new ProjectionService({
    store,
    timers,
    async connect(target) {
      connects.push(target)
      if (connectError !== undefined) throw connectError
      return { rpc, dispose() {} }
    },
  })
  return {
    service,
    store,
    rpc,
    timers,
    connects,
    failConnect(error) {
      connectError = error
    },
  }
}

const ATTACH = { remotePath: TARGET.remoteRoot, localPath: '\\\\wsl.localhost\\ubuntu_dev\\home\\dev\\harness' }

test('接入成功：connected / link=connected / 投影表里有那条工作区', async () => {
  const { service, store } = rig()
  const result = await service.attach(TARGET, ATTACH)
  assert.equal(result.workspace.id, 'ws-1')
  assert.equal(service.connected, true)
  assert.equal(service.link, 'connected')
  assert.deepEqual(service.target, TARGET)
  assert.equal(store.workspaces().length, 1)
  const snapshot = service.snapshot()
  assert.equal(snapshot.link, 'connected')
  assert.equal(snapshot.connected, true)
})

test('传输层失败：标 offline、清连接、相位转 retrying，并按 2s 排第一次重试', async () => {
  const { service, store, rpc, timers } = rig()
  await service.attach(TARGET, ATTACH)
  assert.equal(store.workspaces()[0]?.availability, 'online')

  rpc.failNext(transportLoss())
  await assert.rejects(() => service.attach(TARGET, ATTACH), /tunnel-unavailable/)

  assert.equal(service.connected, false, '隧道断了就不该再说自己连着')
  assert.equal(service.link, 'retrying')
  assert.equal(store.workspaces()[0]?.availability, 'offline', '条目留着并标 offline，不能删')
  assert.equal(service.target?.distro, 'ubuntu_dev', '断线后仍要记得连回哪儿')
  assert.deepEqual(timers.pending(), [2000])
})

test('定时器到点后连回来：重新握手 + 按远端重建投影表，相位回到 connected', async () => {
  const { service, store, rpc, timers, connects } = rig()
  await service.attach(TARGET, ATTACH)
  const before = connects.length

  rpc.failNext(transportLoss())
  await assert.rejects(() => service.attach(TARGET, ATTACH))
  assert.equal(service.link, 'retrying')

  await timers.flush()

  assert.equal(connects.length, before + 1, '重连必须重新 connect，不能复用已废的连接')
  assert.equal(service.connected, true)
  assert.equal(service.link, 'connected')
  assert.equal(store.workspaces()[0]?.availability, 'online', '重连后投影要重新标 online')
  assert.ok(rpc.calls.filter((endpoint) => endpoint === 'workspace/create').length >= 2, '重连要重放 workspace/create')
})

test('重连失败会继续按下一档退避（2s → 4s），而不是放弃', async () => {
  const { service, rpc, timers, failConnect } = rig()
  await service.attach(TARGET, ATTACH)

  // 断线，并且远端确实还没起来：之后每次 connect 都失败。
  rpc.failNext(transportLoss())
  await assert.rejects(() => service.attach(TARGET, ATTACH))
  failConnect(transportLoss())
  assert.deepEqual(timers.pending(), [2000])

  await timers.flush()
  // 这一轮 #attempt 抛错 → #arm 排下一档 4s。2s 那档已被消费。
  assert.deepEqual(timers.pending(), [4000])
  assert.equal(service.link, 'retrying', '还在快速退避档里，不能说成 offline')
})

test('业务拒绝不触发重连：相位仍是 connected，不排重试', async () => {
  const { service, rpc, timers } = rig()
  await service.attach(TARGET, ATTACH)
  rpc.failNext(
    new TeleportError({ code: 'remote/unknown', detail: '远端拒绝：workspace 路径不可写', nextActions: ['换个目录'] }),
  )
  await assert.rejects(() => service.attach(TARGET, ATTACH), /remote\/unknown/)
  assert.equal(service.link, 'connected', '业务拒绝不是断线，别把用户拽进重试')
  assert.deepEqual(timers.pending(), [])
})

test('disconnect 手动断开：标 offline、停掉自动重连、但仍记住 target', async () => {
  const { service, store, rpc, timers } = rig()
  await service.attach(TARGET, ATTACH)
  service.disconnect()

  assert.equal(service.connected, false)
  assert.equal(service.link, 'idle', '手动断开后没有驱动在跑')
  assert.equal(store.workspaces()[0]?.availability, 'offline')
  assert.equal(service.target?.port, 8899, '断开之后面板仍要显示「连的是哪儿」')
  assert.deepEqual(timers.pending(), [], '用户点了断开，就不该在背后偷偷重试')
  void rpc
})

test('从没连过就点重连：抛 remote/disconnected，不静默成功', async () => {
  const { service } = rig()
  assert.equal(service.link, 'idle')
  await assert.rejects(() => service.reconnectNow(), (error: unknown) => {
    assert.ok(error instanceof TeleportError)
    assert.equal(error.code, 'remote/disconnected')
    assert.ok(error.nextActions.length > 0, '失败必须给出可复制的下一步')
    return true
  })
})

test('手动重连成功：连回来并回到 connected', async () => {
  const { service, connects } = rig()
  await service.attach(TARGET, ATTACH)
  service.disconnect()
  const before = connects.length
  await service.reconnectNow()
  assert.equal(connects.length, before + 1)
  assert.equal(service.connected, true)
  assert.equal(service.link, 'connected')
})

test('手动重连失败：如实抛错，并把自动重连挂起来', async () => {
  const { service, timers, failConnect } = rig()
  await service.attach(TARGET, ATTACH)
  service.disconnect()
  failConnect(transportLoss())
  await assert.rejects(() => service.reconnectNow(), /tunnel-unavailable/)
  assert.equal(service.connected, false)
  assert.equal(service.link, 'retrying', '手动重连也失败时，交给自动重连接着试')
  assert.deepEqual(timers.pending(), [2000])
})
