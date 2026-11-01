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
  /** 每次 `rehandshake` 被调用都记一笔。 */
  readonly handshakes: ConnectTarget[]
  /** 每次 `dispose` 被调用都记一笔（留存连接是否真被回收）。 */
  readonly disposals: number[]
  /** 让后续 `connect` 失败。 */
  failConnect(error: unknown): void
  /** 让后续 `rehandshake` 失败（模拟远端进程真的没了）。 */
  failRehandshake(error: unknown): void
  /** 关掉 `rehandshake` 能力（模拟别家实现的连接）。 */
  withoutRehandshake(): void
}

/**
 * 假连接的工厂。`withRehandshake` 默认开 —— 真实实现（`live.ts`）就有这条能力，
 * 只有显式关掉时才模拟「只能重启」的老路径。
 */
function rig(): Rig {
  const store = new ProjectionStore()
  const rpc = fakeRpc()
  const timers = fakeTimers()
  const connects: ConnectTarget[] = []
  const handshakes: ConnectTarget[] = []
  const disposals: number[] = []
  let connectError: unknown = undefined
  let handshakeError: unknown = undefined
  let supportRehandshake = true
  let seq = 0
  const service = new ProjectionService({
    store,
    timers,
    async connect(target) {
      connects.push(target)
      if (connectError !== undefined) throw connectError
      seq += 1
      const id = seq
      const connection = {
        rpc,
        dispose() {
          disposals.push(id)
        },
      }
      if (!supportRehandshake) return connection
      return {
        ...connection,
        async rehandshake() {
          handshakes.push(target)
          if (handshakeError !== undefined) throw handshakeError
        },
      }
    },
  })
  return {
    service,
    store,
    rpc,
    timers,
    connects,
    handshakes,
    disposals,
    failConnect(error) {
      connectError = error
    },
    failRehandshake(error) {
      handshakeError = error
    },
    withoutRehandshake() {
      supportRehandshake = false
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

test('定时器到点后连回来：先只换传输（不重启进程）+ 按远端重建投影表，相位回到 connected', async () => {
  const { service, store, rpc, timers, connects, handshakes, disposals } = rig()
  await service.attach(TARGET, ATTACH)
  const before = connects.length

  rpc.failNext(transportLoss())
  await assert.rejects(() => service.attach(TARGET, ATTACH))
  assert.equal(service.link, 'retrying')

  await timers.flush()

  // 这是 P3.5.2 的核心取舍：远端进程大概率还活着，重开传输 52ms ≪ 重启 9–20s。
  assert.equal(handshakes.length, 1, '断线后必须优先只换传输')
  assert.equal(connects.length, before, '进程没死就不该重新拉进程')
  assert.deepEqual(disposals, [], '也不能把还活着的连接 dispose 掉（那会连带杀远端进程）')
  assert.equal(service.connected, true)
  assert.equal(service.link, 'connected')
  assert.equal(store.workspaces()[0]?.availability, 'online', '重连后投影要重新标 online')
  assert.ok(rpc.calls.filter((endpoint) => endpoint === 'workspace/create').length >= 2, '重连要重放 workspace/create')
})

test('rehandshake 失败说明进程真没了：这时才重新 connect，并把残连接收干净', async () => {
  const { service, connects, handshakes, timers, rpc, failRehandshake } = rig()
  await service.attach(TARGET, ATTACH)
  const before = connects.length

  rpc.failNext(transportLoss())
  await assert.rejects(() => service.attach(TARGET, ATTACH))
  failRehandshake(transportLoss())
  await timers.flush()

  assert.equal(handshakes.length, 1, '先试换传输')
  assert.equal(connects.length, before + 1, '换传输失败才该重启进程')
  assert.equal(service.connected, true)
})

test('连接没有 rehandshake 能力时老实重启：不假装能省掉冷启动', async () => {
  const { service, connects, handshakes, timers, rpc, withoutRehandshake } = rig()
  withoutRehandshake()
  await service.attach(TARGET, ATTACH)
  const before = connects.length

  rpc.failNext(transportLoss())
  await assert.rejects(() => service.attach(TARGET, ATTACH))
  await timers.flush()

  assert.equal(handshakes.length, 0, '没有这条能力就不该记成用过')
  assert.equal(connects.length, before + 1)
  assert.equal(service.connected, true)
})

test('手动断开只断传输：不 dispose，远端进程留着温热', async () => {
  const { service, rpc, disposals } = rig()
  await service.attach(TARGET, ATTACH)
  rpc.failNext(transportLoss())
  await assert.rejects(() => service.attach(TARGET, ATTACH))
  // 断线时连接被留存，不该已经 dispose。
  assert.deepEqual(disposals, [], '断线不能 dispose —— 那会连带杀掉远端进程')
  service.disconnect()
  // 断开同样只断传输（architecture.md §8.5：回收归退出/cleanup，不归断开）。
  // 这样「断开 → 重连」是 52ms 的重握手，而不是 9–20s 冷启动。
  assert.deepEqual(disposals, [], '断开也不该 dispose —— 远端进程留着，下次重连才快')
})

test('recycle 才真收：进程退出/换 target 时才把远端进程收掉', async () => {
  const { service, rpc, disposals } = rig()
  await service.attach(TARGET, ATTACH)
  rpc.failNext(transportLoss())
  await assert.rejects(() => service.attach(TARGET, ATTACH))
  assert.deepEqual(disposals, [], '断线不能 dispose')
  service.recycle()
  assert.deepEqual(disposals, [1], 'recycle 才真收')
})

test('断开后再接入同一 target：救回留存连接重握手，不重付冷启动', async () => {
  const { service, connects, handshakes, rpc } = rig()
  await service.attach(TARGET, ATTACH)
  const before = connects.length
  rpc.failNext(transportLoss())
  await assert.rejects(() => service.attach(TARGET, ATTACH))
  service.disconnect()

  // 断开只是断传输，连接还在 #detached 里 —— 再接入应该重握手，不该重新起进程。
  await service.attach(TARGET, ATTACH)
  assert.equal(connects.length, before, '重握手成功就不该重新 connect')
  assert.equal(handshakes.length, 1, '走的是重握手这条路')
})

test('重连失败会继续按下一档退避（2s → 4s），而不是放弃', async () => {
  const { service, rpc, timers, failConnect, failRehandshake } = rig()
  await service.attach(TARGET, ATTACH)

  // 断线，并且远端确实还没起来：换传输失败、重新 connect 也失败。
  // 两条都要打掉 —— 只要 rehandshake 还能成功，这一轮就真的连回来了（那才是常态）。
  rpc.failNext(transportLoss())
  await assert.rejects(() => service.attach(TARGET, ATTACH))
  failRehandshake(transportLoss())
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

test('手动重连成功：只换传输、不重启进程，连回来并回到 connected', async () => {
  const { service, connects, handshakes } = rig()
  await service.attach(TARGET, ATTACH)
  service.disconnect()
  const before = connects.length
  await service.reconnectNow()
  // 这是 §7 那条「手动重连 ≤5s」能不能达标的产品侧根因：
  // 重启远端实测 9–20s，重握手实测 52ms。
  assert.equal(connects.length, before, '进程还活着就不该重启')
  assert.equal(handshakes.length, 1)
  assert.equal(service.connected, true)
  assert.equal(service.link, 'connected')
})

test('手动重连失败：如实抛错，并把自动重连挂起来', async () => {
  const { service, timers, failConnect, failRehandshake } = rig()
  await service.attach(TARGET, ATTACH)
  service.disconnect()
  // 远端进程真没了：重握手和重启都得失败，才轮得到「挂上自动重连」。
  failRehandshake(transportLoss())
  failConnect(transportLoss())
  await assert.rejects(() => service.reconnectNow(), /tunnel-unavailable/)
  assert.equal(service.connected, false)
  assert.equal(service.link, 'retrying', '手动重连也失败时，交给自动重连接着试')
  assert.deepEqual(timers.pending(), [2000])
})
