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

import { RemoteCrError } from '../backend/errors.ts'
import type { ProjectionRpc, StreamEvent, StreamHandle } from './remote.ts'
import { ProjectionService, defaultWarmupMs, refreshKey, type ConnectTarget } from './service.ts'
import { TERMINAL_WARMUP_MS } from './probe.ts'
import { ProjectionStore } from './store.ts'
import type { RemoteSessionSummary } from './attach.ts'
import type { ReconnectTimers } from '../../shared/reconnect.ts'

const TARGET: ConnectTarget = {
  backend: 'wsl',
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

/**
 * 假 RPC：记住被调过的端点，回最小可解析形状。
 *
 * `listed` 是远端的「会话真相」，默认空数组（既有用例看到的形状完全不变）。刷新用例
 * 靠它造出「远端这次说 running=false」：`workspace/create` 也按它回 `sessionIds`，
 * 这样接入时那批会话才会真被投影出来（归属只认远端给的 sessionIds，不按 cwd 猜）。
 */
function fakeRpc(listed: readonly RemoteSessionSummary[] = []): FakeRpc {
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
            sessionIds: listed.map((row) => row.sessionId),
            createdAt: '',
            updatedAt: '',
          },
          created: true,
        } as T
      }
      // 每次现取：用例改的是 `listed` 的内容（远端状态变了），假连接不持有旧副本。
      if (endpoint === 'session/list') return { items: listed.map((row) => ({ ...row })) } as T
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


test('导入：连接没有 anchorFor 时抛 remote/not-attached（WSL 后端不支持导入）', async () => {
  // WSL 的连接不提供 anchorFor：导入必须**明确拒绝**，而不是把远端路径硬塞进 create。
  const service = new ProjectionService({
    store: new ProjectionStore(),
    timers: fakeTimers(),
    connect: async () => ({ rpc: fakeRpc(), dispose: async () => true }),
  })
  await service.attach(TARGET, { remotePath: TARGET.remoteRoot, localPath: 'C:/anchor/x' })
  await assert.rejects(
    () => service.importWorkspaces([TARGET.remoteRoot]),
    (error: unknown) => (error as { code?: string }).code === 'remote/not-attached',
  )
})

function transportLoss(): RemoteCrError {
  return new RemoteCrError({
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
  assert.deepEqual(service.target, TARGET, '断线后仍要记得连回哪儿')
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
  await service.recycle()
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
    new RemoteCrError({ code: 'remote/unknown', detail: '远端拒绝：workspace 路径不可写', nextActions: ['换个目录'] }),
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
    assert.ok(error instanceof RemoteCrError)
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
/**
 * 预热窗口是**后端事实**，不是全局常数：WSL 的 bash 装了 ble.sh，新终端要等；
 * SSH 目标上那条经验会把首命令推过 3s 门禁（2026-11-13 在 gcp 上量到预热与耗时严格线性）。
 */
test('取证预热窗口按后端给缺省值，SSH 目标不等待', () => {
  const ssh: ConnectTarget = { backend: 'ssh', alias: 'gcp', port: 8938, remoteRoot: '/home/hui/workspace' }
  assert.equal(defaultWarmupMs(ssh), 0, 'SSH 目标上不存在可等的初始化积压，等待只会让首命令变慢')
  assert.equal(defaultWarmupMs(TARGET), TERMINAL_WARMUP_MS, 'WSL 仍然要等 ble.sh')
  assert.equal(defaultWarmupMs(null), TERMINAL_WARMUP_MS, '还没连上时按保守值，不能因为不知道就清零')
})

test('接入过程逐段上报阶段，且每次上报时快照里的阶段与它一致（A5 的进度来源）', async () => {
  const store = new ProjectionStore()
  const rpc = fakeRpc()
  const service = new ProjectionService({
    store,
    timers: fakeTimers(),
    async connect(_target, control) {
      control?.onPhase?.('bootstrap')
      control?.onPhase?.('launch')
      return { rpc, dispose() {} }
    },
  })
  const seen: string[] = []
  await service.attach(TARGET, ATTACH, {
    onPhase(phase) {
      seen.push(phase)
      // 上报与快照必须同源：面板只看快照，两边一旦分叉，用户看到的就是错的阶段。
      assert.equal(service.snapshot().attach?.phase, phase)
    },
  })
  assert.deepEqual(seen, ['bootstrap', 'launch', 'attach'])
  assert.equal(service.snapshot().attach, null, '接入结束（成功也算）必须清掉进度，否则面板永远停在接入中')
})

test('取消接入：signal 递给连接层，失败后进度归 null 且连接相位不变', async () => {
  const controller = new AbortController()
  const seen: Array<AbortSignal | undefined> = []
  const service = new ProjectionService({
    store: new ProjectionStore(),
    timers: fakeTimers(),
    async connect(_target, control) {
      seen.push(control?.signal)
      controller.abort()
      throw new RemoteCrError({ code: 'remote/cancelled', detail: '已取消这次接入', nextActions: ['重新点一次「接入」'] })
    },
  })
  const caught = await service.attach(TARGET, ATTACH, { signal: controller.signal }).then(
    () => undefined,
    (error: unknown) => error,
  )
  assert.ok(caught instanceof RemoteCrError, '取消要如实抛错，不能静默成功')
  assert.equal((caught as RemoteCrError).code, 'remote/cancelled')
  assert.deepEqual(seen, [controller.signal], 'signal 必须真的递到连接层，否则取消只是把按钮变灰')
  assert.equal(service.attachProgress, null)
  assert.equal(service.connected, false)
  assert.equal(service.link, 'idle')
})

test('取消发生在 workspace/create 返回之后：抛 remote/cancelled，且不许把条目写进投影表', async () => {
  const store = new ProjectionStore()
  const timers = fakeTimers()
  const controller = new AbortController()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const rpc = {
    async call<T>(endpoint: string): Promise<T> {
      if (endpoint === 'workspace/create') {
        await gate
        return {
          workspace: { workspaceId: 'ws-cancel', path: TARGET.remoteRoot, title: 'w', sessionIds: [], createdAt: '', updatedAt: '' },
          created: true,
        } as T
      }
      return { items: [] } as T
    },
    openStream() {
      return { cancel() {}, async *[Symbol.asyncIterator]() {} }
    },
  }
  const service = new ProjectionService({
    store,
    timers,
    async connect() {
      return { rpc: rpc as never, dispose() {} }
    },
  })
  const running = service.attach(
    TARGET,
    { remotePath: TARGET.remoteRoot, localPath: 'C:/anchor/x' },
    { signal: controller.signal },
  )
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  release()
  await assert.rejects(
    running,
    (error: unknown) => error instanceof RemoteCrError && error.code === 'remote/cancelled',
  )
  // 复现 3 的真问题：取消回执说「已取消」，投影表却留下一条 online 工作区。
  assert.equal(store.workspaces().length, 0, '取消之后不许留下在线条目')
})

test('并发第二次 attach 被 remote/attach-busy 拒绝，且不覆盖第一次的进度', async () => {
  const timers = fakeTimers()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const rpc = {
    async call<T>(endpoint: string): Promise<T> {
      if (endpoint === 'workspace/create') {
        await gate
        return {
          workspace: { workspaceId: 'ws-busy', path: TARGET.remoteRoot, title: 'w', sessionIds: [], createdAt: '', updatedAt: '' },
          created: true,
        } as T
      }
      return { items: [] } as T
    },
    openStream() {
      return { cancel() {}, async *[Symbol.asyncIterator]() {} }
    },
  }
  const service = new ProjectionService({
    store: new ProjectionStore(),
    timers,
    async connect() {
      return { rpc: rpc as never, dispose() {} }
    },
  })
  const first = service.attach(TARGET, { remotePath: TARGET.remoteRoot, localPath: 'C:/anchor/x' })
  await new Promise((resolve) => setImmediate(resolve))
  await assert.rejects(
    service.attach({ ...TARGET, distro: 'other' }, { remotePath: TARGET.remoteRoot, localPath: 'C:/anchor/y' }),
    (error: unknown) => error instanceof RemoteCrError && error.code === 'remote/attach-busy',
  )
  assert.notEqual(service.attachProgress, null, '第一次的进度不该被清空')
  assert.deepEqual(service.attachProgress?.target, TARGET, '进度仍指向第一次的目标')
  release()
  await first
})

test('取消发生在 session/list 期间：抛 remote/cancelled，且投影表一条都不写', async () => {
  const store = new ProjectionStore()
  const timers = fakeTimers()
  const controller = new AbortController()
  let releaseSessions!: () => void
  const sessionGate = new Promise<void>((resolve) => { releaseSessions = resolve })
  const rpc = {
    async call<T>(endpoint: string): Promise<T> {
      if (endpoint === 'workspace/create') {
        return {
          workspace: { workspaceId: 'ws-c3', path: TARGET.remoteRoot, title: 'w', sessionIds: [], createdAt: '', updatedAt: '' },
          created: true,
        } as T
      }
      if (endpoint === 'session/list') await sessionGate
      return { items: [] } as T
    },
    openStream() {
      return { cancel() {}, async *[Symbol.asyncIterator]() {} }
    },
  }
  const service = new ProjectionService({
    store,
    timers,
    async connect() {
      return { rpc: rpc as never, dispose() {} }
    },
  })
  const running = service.attach(
    TARGET,
    { remotePath: TARGET.remoteRoot, localPath: 'C:/anchor/c3' },
    { signal: controller.signal },
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  controller.abort()
  releaseSessions()
  await assert.rejects(
    running,
    (error: unknown) => error instanceof RemoteCrError && error.code === 'remote/cancelled',
  )
  // R1 #2 C3：`session/list` 段取消时若 workspace 已写进去，面板会看到在线条目而请求报已取消。
  assert.equal(store.workspaces().length, 0, 'session/list 段取消也不许写投影')
})

test('取消发生在 attach 段：本次新建的连接要被 dispose，而不是留成 connected', async () => {
  const store = new ProjectionStore()
  const timers = fakeTimers()
  const controller = new AbortController()
  let disposed = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const rpc = {
    async call<T>(endpoint: string): Promise<T> {
      if (endpoint === 'workspace/create') {
        await gate
        return {
          workspace: { workspaceId: 'ws-c5', path: TARGET.remoteRoot, title: 'w', sessionIds: [], createdAt: '', updatedAt: '' },
          created: true,
        } as T
      }
      return { items: [] } as T
    },
    openStream() {
      return { cancel() {}, async *[Symbol.asyncIterator]() {} }
    },
  }
  const service = new ProjectionService({
    store,
    timers,
    async connect() {
      return {
        rpc: rpc as never,
        dispose() {
          disposed += 1
        },
      }
    },
  })
  const running = service.attach(
    TARGET,
    { remotePath: TARGET.remoteRoot, localPath: 'C:/anchor/c5' },
    { signal: controller.signal },
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  controller.abort()
  release()
  await assert.rejects(
    running,
    (error: unknown) => error instanceof RemoteCrError && error.code === 'remote/cancelled',
  )
  // R1 #2 C5：取消后若连接还在、远端还在监听，就是「取消了什么也没发生」的假象。
  assert.equal(disposed, 1, '取消要回收本次新建的连接')
  assert.equal(service.connected, false)
})

// ── 刷新（R1）：恰好 1 次 session/list；失败留旧表并标 stale ──────────────────

/** 一条远端会话摘要；`running` 随「远端那边跑完了」而改。 */
function sessionRow(running: boolean): RemoteSessionSummary {
  return { sessionId: 'sess-1', updatedAt: Date.parse('2026-11-19T03:04:05.000Z'), running, blank: false }
}

test('refreshKey 与 sameTarget 同形：换端口或换检出根就是另一个键（P4 P2-1）', () => {
  const base = { backend: 'wsl' as const, distro: 'ubuntu_dev', port: 8899, remoteRoot: '/home/dev/h' }
  assert.equal(refreshKey(base), refreshKey({ ...base }), '完全相同 → 同一个键（单飞才成立）')
  assert.notEqual(refreshKey(base), refreshKey({ ...base, port: 8900 }), '同发行版换端口 = 另一台')
  assert.notEqual(refreshKey(base), refreshKey({ ...base, remoteRoot: '/home/dev/other' }), '换检出根 = 另一台')
})

test('刷新把远端的 running true→false 贴回快照：RPC 序列恰为 session/list（没写 workspace/create）', async () => {
  const store = new ProjectionStore()
  const listed: RemoteSessionSummary[] = [sessionRow(true)]
  const rpc = fakeRpc(listed)
  const service = new ProjectionService({
    store,
    timers: fakeTimers(),
    async connect() {
      return { rpc, dispose() {} }
    },
  })
  await service.attach(TARGET, ATTACH)
  assert.equal(store.sessions('ws-1')[0]?.running, true, '接入那一帧远端说它还在跑')
  assert.equal(service.snapshot().stale, false, '刚接入过，表不是旧的')

  // 远端那边任务结束了。刷新要把它贴回本地表，否则面板里的「运行中」永久挂住。
  listed[0] = sessionRow(false)
  rpc.calls.length = 0
  const outcome = await service.refreshSessions()

  assert.deepEqual(rpc.calls, ['session/list'], '刷新只许读一次 session/list：出现 workspace/create 就是打了写接口')
  assert.deepEqual(outcome, { updated: 1, missing: 0 })
  const snapshot = service.snapshot()
  assert.equal(snapshot.sessions[0]?.running, false, 'running 必须落到快照上')
  assert.equal(snapshot.sessions[0]?.updatedAt, '2026-11-19T03:04:05.000Z', '时间以远端为准')
  assert.equal(snapshot.stale, false, '刷新成功就该清掉旧帧标记')
})

test('刷新失败：原错误原样抛、旧帧留着、stale 置 true（不清表）', async () => {
  const store = new ProjectionStore()
  const rpc = fakeRpc([sessionRow(true)])
  const service = new ProjectionService({
    store,
    timers: fakeTimers(),
    async connect() {
      return { rpc, dispose() {} }
    },
  })
  await service.attach(TARGET, ATTACH)

  const failure = new RemoteCrError({
    code: 'remote/unknown',
    detail: '远端拒绝：session/list 不可用',
    nextActions: ['重试一次'],
  })
  rpc.failNext(failure)
  // 原样抛：不包一层新错，也不吞成布尔值 —— 面板要靠这条错误拿到码与宿主原文。
  await assert.rejects(
    () => service.refreshSessions(),
    (error: unknown) => error === failure,
  )

  const snapshot = service.snapshot()
  assert.equal(snapshot.sessions.length, 1, '刷新失败不许清空旧帧')
  assert.equal(snapshot.sessions[0]?.running, true, '旧帧原样留着（只是不再声称它新）')
  assert.equal(snapshot.stale, true, '旧帧必须被标成旧的')
  assert.equal(snapshot.connected, true, '业务拒绝不是断线，别把用户拽进重试')
})

test('没接入就刷新：抛 remote/disconnected，且一次 RPC 都不发', async () => {
  const store = new ProjectionStore()
  const rpc = fakeRpc([sessionRow(true)])
  let connects = 0
  const service = new ProjectionService({
    store,
    timers: fakeTimers(),
    async connect() {
      connects += 1
      return { rpc, dispose() {} }
    },
  })

  const isDisconnected = (error: unknown): true => {
    assert.ok(error instanceof RemoteCrError)
    assert.equal(error.code, 'remote/disconnected')
    assert.ok(error.detail.includes('接入'), error.detail)
    assert.ok(error.nextActions.length >= 1 && error.nextActions.length <= 2, '下一步给 1–2 条，别铺满屏')
    return true
  }
  await assert.rejects(() => service.refreshSessions(), isDisconnected)
  assert.equal(connects, 0, '刷新不得顺手连一次远端')
  assert.deepEqual(rpc.calls, [], '未连接时不得发起任何 RPC')

  // 掉线之后同理：连接对象还在留存槽里，但口径是「现在没连着」，那就一个 RPC 都不发。
  await service.attach(TARGET, ATTACH)
  service.disconnect()
  rpc.calls.length = 0
  await assert.rejects(() => service.refreshSessions(), isDisconnected)
  assert.deepEqual(rpc.calls, [], '断开后刷新同样一个 RPC 都不发')
})

test('并发两次刷新按 target 单飞：只打一次 session/list，两边拿到同一份计数', async () => {
  // R3 的「同 target 不叠请求」。两次点击是同步发生的（按钮 + 轮询就是这样撞上的），
  // 所以这里不插闸门：`RefreshGuard` 在**登记阶段**就同步占位，第二次直接拿到同一个 promise。
  const store = new ProjectionStore()
  const rpc = fakeRpc([sessionRow(false)])
  const service = new ProjectionService({
    store,
    timers: fakeTimers(),
    async connect() {
      return { rpc, dispose() {} }
    },
  })
  await service.attach(TARGET, ATTACH)
  rpc.calls.length = 0

  const [left, right] = await Promise.all([service.refreshSessions(), service.refreshSessions()])

  assert.deepEqual(rpc.calls, ['session/list'], '两次并发刷新只许打一次远端：叠请求会把同一帧写两遍')
  assert.deepEqual(left, right, '单飞 = 共享同一次结果，不是「一个成功一个报忙」')
  assert.deepEqual(left, { updated: 1, missing: 0 })
  assert.equal(service.snapshot().stale, false)
})
