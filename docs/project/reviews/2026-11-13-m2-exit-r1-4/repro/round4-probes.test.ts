/**
 * R1 #4（第四轮复审）夹具 · 2026-11-13 · M2 出口
 *
 * 极性说明（照仓库惯例）：
 *   D 系列 —— 断言「缺陷成立」，绿 = 缺陷还在。
 *   P 系列 —— 断言「修复成立」，绿 = 这一轮真的堵住了。
 *
 * 跑法（仓库根）：
 *   node --test docs/project/reviews/2026-11-13-m2-exit-r1-4/repro/round4-probes.test.ts
 *
 * 只依赖产品代码 + 注入的假连接 / 假 spawn，不碰真机、不占 3131/8961。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import type { SshTarget } from '../../../../../src/local/backend/ssh/config.ts'
import type { SshLaunchChild, SshLaunchSpawn } from '../../../../../src/local/backend/ssh/launch.ts'
import { launchSshDsh } from '../../../../../src/local/backend/ssh/launch.ts'
import { TeleportError } from '../../../../../src/local/backend/errors.ts'
import type { ProjectionRpc, StreamEvent, StreamHandle } from '../../../../../src/local/projection/remote.ts'
import { ProjectionService, type ConnectTarget } from '../../../../../src/local/projection/service.ts'
import { ProjectionStore } from '../../../../../src/local/projection/store.ts'

const T1: ConnectTarget = { backend: 'ssh', alias: 'gcp', port: 8961, remoteRoot: '/home/hui/workspace' }
const T2: ConnectTarget = { backend: 'ssh', alias: 'gcp-2', port: 8961, remoteRoot: '/home/hui/workspace' }
const ATTACH = { remotePath: '/home/hui/workspace', localPath: 'C:/anchor/home/hui/workspace' }
const timers = { schedule: () => 0, cancel: () => {} }

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function rpc(handle: (endpoint: string) => Promise<unknown>): ProjectionRpc {
  return {
    call: async <T>(endpoint: string): Promise<T> => (await handle(endpoint)) as T,
    openStream(): StreamHandle {
      const events: StreamEvent[] = []
      return { cancel() {}, async *[Symbol.asyncIterator]() { for (const event of events) yield event } }
    },
  }
}

function cancelled(): TeleportError {
  return new TeleportError({ code: 'remote/cancelled', detail: '已取消这次接入', nextActions: [] })
}

function workspace(id: string): unknown {
  return {
    workspace: {
      workspaceId: id,
      path: '/home/hui/workspace',
      title: 'w',
      sessionIds: [],
      createdAt: '',
      updatedAt: '',
    },
    created: true,
  }
}

/** 一条可观测的假连接：dispose 计数 + 可选 rehandshake。 */
interface FakeConn {
  readonly rpc: ProjectionRpc
  readonly disposes: { count: number }
  rehandshake?(): Promise<void>
  dispose(): void
}

function fakeConn(options: { rpc?: ProjectionRpc; rehandshake?: () => Promise<void> } = {}): FakeConn {
  const disposes = { count: 0 }
  const conn: FakeConn = {
    rpc: options.rpc ?? rpc(async (endpoint) => (endpoint === 'workspace/create' ? workspace('ws') : { items: [] })),
    disposes,
    dispose() { disposes.count += 1 },
  }
  if (options.rehandshake !== undefined) {
    Object.defineProperty(conn, 'rehandshake', { value: options.rehandshake, enumerable: true })
  }
  return conn
}

// ── D1：换 target 后取消 —— 回滚把 A 塞回 #live，但 A 还在 #detached 里 ──────────
// service.ts 的回滚只做 #live = liveBefore：A 是被 disconnect() → #detatch(A) 存进
// #detached 的，回滚后同一个连接对象同时挂在 #live 与 #detached 上（两者按注释互斥）。
// 后果不是理论：recycle() / 进程退出会对同一个连接 dispose 两次。
test('D1：换 target 取消后 A 同时挂在 #live 与 #detached，recycle 对 A 收两次', async () => {
  const store = new ProjectionStore()
  const a = fakeConn()
  const b = fakeConn()
  const gate = deferred<void>()
  let calls = 0
  const service = new ProjectionService({
    store,
    timers,
    async connect() {
      calls += 1
      if (calls === 1) return a as never
      return { ...b, rpc: rpc(async (endpoint) => {
        if (endpoint === 'workspace/create') { await gate.promise; return workspace('ws-b') }
        return { items: [] }
      }) } as never
    },
  })

  await service.attach(T1, ATTACH)
  const controller = new AbortController()
  const running = service.attach(T2, ATTACH, { signal: controller.signal })
  await tick()
  controller.abort()
  gate.resolve()
  await assert.rejects(running, (error: unknown) => (error as { code?: string }).code === 'remote/cancelled')

  // 回滚本身是对的：A 回到 #live（见 P1）。问题在 A 还留在 #detached 里。
  service.recycle()
  assert.equal(a.disposes.count, 2, 'recycle 对同一条连接 dispose 了两次（#live 与 #detached 同时持有 A）')
})

// ── D2：取消落在 #connect 期间 —— 整段回滚根本不执行 ────────────────────────
// finally 的条件是 #live 存在且不等于 liveBefore。换 target 时 #ensure 先 disconnect()
// （#live = undefined）再 connect；取消若落在 connect 里，#live 仍是 undefined，于是
// 「回滚到接入前状态」整句不生效：A 的会话没了、投影全 offline、link=idle。
test('D2：换 target 时取消落在 #connect 里 ⇒ 不回滚到接入前（connected=false、link=idle）', async () => {
  const store = new ProjectionStore()
  const a = fakeConn()
  const gate = deferred<void>()
  let calls = 0
  const service = new ProjectionService({
    store,
    timers,
    async connect() {
      calls += 1
      if (calls === 1) return a as never
      await gate.promise
      throw cancelled()
    },
  })

  await service.attach(T1, ATTACH)
  assert.equal(service.connected, true, '前提：先连着 A')
  const controller = new AbortController()
  const running = service.attach(T2, ATTACH, { signal: controller.signal })
  await tick()
  controller.abort()
  gate.resolve()
  await assert.rejects(running, (error: unknown) => (error as { code?: string }).code === 'remote/cancelled')

  const snapshot = service.snapshot()
  assert.equal(snapshot.connected, false, '接入前 connected=true，取消后成了 false —— 没有回滚')
  assert.equal(snapshot.link, 'idle', '也不是 offline/retrying：面板没有任何「A 还活着」的线索')
  assert.deepEqual(snapshot.target, T1, 'target 仍报 A（来自 #lastTarget）')
  assert.equal(store.workspaces().every((entry) => entry.availability === 'offline'), true, 'A 的工作区被 disconnect() 标成 offline，回滚没还原')

  service.recycle()
  assert.equal(a.disposes.count, 1, 'A 最终是被 recycle 收掉的，不是被取消回滚收掉的')
})

// ── D3：复用「留存连接」后取消 ⇒ 把既有连接 dispose 了（§8.5 说复用要保留）─────
// 先 disconnect() 造出 #detached=A，再接入同一 target：#ensure 走 rehandshake 把 A 救回
// #live（「省掉 9–20s 冷启动」那条路）。此时取消：liveBefore 是 undefined，
// #live !== liveBefore 恒真 ⇒ 判定成「本次新建」，把 A 收掉。
test('D3：救回留存连接后取消 ⇒ 既有连接被 dispose（复用分支被当成新建）', async () => {
  const store = new ProjectionStore()
  const a = fakeConn({ rehandshake: async () => {} })
  const gate = deferred<void>()
  let calls = 0
  const service = new ProjectionService({
    store,
    timers,
    async connect() {
      calls += 1
      return { ...a, rpc: rpc(async (endpoint) => {
        if (endpoint === 'workspace/create') { await gate.promise; return workspace('ws-a') }
        return { items: [] }
      }) } as never
    },
  })

  await service.attach(T1, ATTACH)
  service.disconnect()
  assert.equal(service.connected, false)

  const controller = new AbortController()
  const running = service.attach(T1, ATTACH, { signal: controller.signal })
  await tick()
  controller.abort()
  gate.resolve()
  await assert.rejects(running, (error: unknown) => (error as { code?: string }).code === 'remote/cancelled')

  assert.equal(a.disposes.count, 1, '复用（rehandshake 救回）的既有连接被取消连同远端进程一起收掉了')
  assert.equal(service.connected, false, '接入前有 #detached 的活连接，取消后连留存也没了')
  assert.equal(calls, 1, '这一跑确实没有新建连接（connect 只被调了一次）')
})

// ── P1：D1 的修法正证 —— 换 target 取消后回到「连着 A」 ──────────────────────
test('P1：换 target 取消后回滚到接入前的 #live（connected=true、target=T1、B 被收）', async () => {
  const store = new ProjectionStore()
  const a = fakeConn()
  const b = fakeConn()
  const gate = deferred<void>()
  let calls = 0
  const service = new ProjectionService({
    store,
    timers,
    async connect() {
      calls += 1
      if (calls === 1) return a as never
      return { ...b, rpc: rpc(async (endpoint) => {
        if (endpoint === 'workspace/create') { await gate.promise; return workspace('ws-b') }
        return { items: [] }
      }) } as never
    },
  })

  await service.attach(T1, ATTACH)
  const controller = new AbortController()
  const running = service.attach(T2, ATTACH, { signal: controller.signal })
  await tick()
  controller.abort()
  gate.resolve()
  await assert.rejects(running, (error: unknown) => (error as { code?: string }).code === 'remote/cancelled')

  assert.equal(b.disposes.count, 1, '本次新建的 B 被 dispose')
  assert.equal(a.disposes.count, 0, '复用的 A 一条都没被收')
  assert.equal(service.connected, true, '回滚到接入前：仍然连着')
  assert.deepEqual(service.snapshot().target, T1, '回滚后是 A，不是 B')
})

// ── P2：同一 target 复用 + 取消 ⇒ 不误伤 ────────────────────────────────
test('P2：同 target 复用后取消不 dispose 用户正在用的连接', async () => {
  const store = new ProjectionStore()
  const a = fakeConn()
  const gate = deferred<void>()
  let calls = 0
  const service = new ProjectionService({
    store,
    timers,
    async connect() {
      calls += 1
      return { ...a, rpc: rpc(async (endpoint) => {
        if (endpoint === 'workspace/create') { await gate.promise; return workspace('ws-a') }
        return { items: [] }
      }) } as never
    },
  })

  await service.attach(T1, ATTACH)
  const controller = new AbortController()
  const running = service.attach(T1, ATTACH, { signal: controller.signal })
  await tick()
  controller.abort()
  gate.resolve()
  await assert.rejects(running, (error: unknown) => (error as { code?: string }).code === 'remote/cancelled')

  assert.equal(calls, 1, '同 target 复用：没有新建连接')
  assert.equal(a.disposes.count, 0, '复用的连接没被收')
  assert.equal(service.connected, true)
})

// ── P3：M-E / D2 —— offline 条目与幂等命中不会变成两条 ───────────────────
test('P3：session/list 失败写 offline 条目；再接入成功仍是一条（且转 online）', async () => {
  const store = new ProjectionStore()
  let createCalls = 0
  let listCalls = 0
  const service = new ProjectionService({
    store,
    timers,
    async connect() {
      return {
        rpc: rpc(async (endpoint) => {
          if (endpoint === 'workspace/create') {
            createCalls += 1
            return { workspace: { workspaceId: 'ws-x', path: '/home/hui/workspace', title: 'w', sessionIds: [], createdAt: '', updatedAt: '' }, created: createCalls === 1 }
          }
          listCalls += 1
          if (listCalls === 1) throw new TeleportError({ code: 'remote/tunnel-unavailable', detail: 'boom', nextActions: [] })
          return { items: [] }
        }),
        dispose() {},
      } as never
    },
  })

  await assert.rejects(service.attach(T1, ATTACH), (error: unknown) => (error as { code?: string }).code === 'remote/tunnel-unavailable')
  assert.equal(store.workspaces().length, 1, '第一条：offline 占位（M-E 的修复）')
  assert.equal(store.workspaces()[0]?.availability, 'offline')

  const second = await service.attach(T1, ATTACH)
  assert.equal(second.created, false, '第二次远端幂等命中')
  assert.equal(store.workspaces().length, 1, '不会变成「一条 offline + 一条 online」——主键是远端 workspaceId')
  assert.equal(store.workspaces()[0]?.availability, 'online', '同一条被改回 online')
})

// ── M-B 的分类顺序：ssh 自己的拒绝 vs 远端 shell / dsh 的话术 ──────────────
const TARGET: SshTarget = {
  alias: 'syy',
  hostName: '198.51.100.8',
  user: 'hui',
  port: 22,
  identityFiles: [],
  proxyJump: [],
  source: { file: 'C:/Users/hui/.ssh/config', line: 20 },
}

class FakeLaunchChild {
  readonly events = new EventEmitter()
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly stdin = { write: (): boolean => true, end: (): void => {} }
  on(event: string, listener: (...args: never[]) => void): this {
    this.events.on(event, listener as never)
    return this
  }
  kill(): boolean { return true }
  asChild(): SshLaunchChild { return this as unknown as SshLaunchChild }
}

interface LauncherScript {
  readonly stderr: readonly string[]
  readonly stdout: readonly string[]
  readonly exitCode: number
}

function spawnOf(script: LauncherScript): SshLaunchSpawn {
  return () => {
    const child = new FakeLaunchChild()
    setImmediate(() => {
      for (const chunk of script.stderr) child.stderr.emit('data', Buffer.from(chunk))
      for (const chunk of script.stdout) child.stdout.emit('data', Buffer.from(chunk))
      child.events.emit('exit', script.exitCode, null)
      child.events.emit('close', script.exitCode, null)
    })
    return child.asChild()
  }
}

interface Captured { code: string; detail: string; logTail: string }
let captured: Captured = { code: '', detail: '', logTail: '' }

async function failureCode(script: LauncherScript, authKind: 'key' | 'agent' | 'password' = 'key'): Promise<Captured> {
  await assert.rejects(
    launchSshDsh({
      homeDir: 'D:/Temp/teleport-home',
      target: TARGET,
      auth: { kind: authKind } as never,
      remoteRoot: '/home/hui/workspace',
      remotePort: 8899,
      localPort: 31811,
      timeoutMs: 2000,
      disposeGraceMs: 40,
      disposeSettleMs: 60,
      spawn: spawnOf(script),
    } as never),
    (error: unknown) => {
      const teleport = error as TeleportError
      captured = { code: teleport.code, detail: teleport.detail, logTail: teleport.logTail ?? '' }
      return true
    },
  )
  return captured
}

test('P4：stderr-only 的 Permission denied (publickey). ⇒ remote/auth-failed（M-B 的正面）', async () => {
  const got = await failureCode({ stderr: ['Permission denied (publickey).\r\n'], stdout: [], exitCode: 255 })
  assert.equal(got.code, 'remote/auth-failed', '认证错误表真的被调用了：' + got.code + ' / ' + got.detail.slice(0, 60))
})

test('P5：远端 shell 自己的 Permission denied 不被误判成认证错误', async () => {
  const got = await failureCode({ stderr: ['bash: line 1: cd: /home/hui/ws: Permission denied\r\n'], stdout: [], exitCode: 1 })
  assert.notEqual(got.code, 'remote/auth-failed', '没被说成「服务端 authorized_keys 里没有这把公钥」')
  assert.notEqual(got.code, 'remote/password-unavailable')
  assert.equal(got.code, 'remote/startup-failed', '落到 dsh 话术（detail：' + got.detail.slice(0, 40) + '）')
})

// ── D4：优先级只看子串、不看来源 —— dsh 侧的通用英文会被读成 ssh 拒绝 ──────────
// 夹具文案是合成的（把远端 dsh 日志里可能出现的一句英文塞进同一条 buffer），
// 它证明的是判据机制：classifyFailure 拿整条 buffer（ssh stderr + 远端 dsh 的
// stdout/stderr）去过 ssh 表，命中即返回，dsh 话术分支再也走不到。
test('D4：buffer 里混进 dsh 侧的一句 Connection refused ⇒ 被读成 remote/host-unreachable', async () => {
  const got = await failureCode({
    stderr: [],
    stdout: ['dsh web: starting...\n', 'warn: media proxy upstream Connection refused\n'],
    exitCode: 1,
  })
  assert.equal(got.code, 'remote/host-unreachable', '被说成「连不上目标：端口拒绝 / 解析失败 / 路由不可达」')
  assert.match(got.detail, /连不上/, 'detail 指向 ssh 侧的连接问题')
})

// ── D5：回滚只回滚 #live，不回滚投影状态 ────────────────────────────────
test('D5：回滚后 connected=true 但所有工作区仍是 offline（投影没回滚）', async () => {
  const store = new ProjectionStore()
  const a = fakeConn()
  const gate = deferred<void>()
  let calls = 0
  const service = new ProjectionService({
    store,
    timers,
    async connect() {
      calls += 1
      if (calls === 1) return a as never
      return { ...fakeConn(), rpc: rpc(async (endpoint) => {
        if (endpoint === 'workspace/create') { await gate.promise; return workspace('ws-b') }
        return { items: [] }
      }) } as never
    },
  })

  await service.attach(T1, ATTACH)
  assert.equal(store.workspaces()[0]?.availability, 'online', '前提：接入后是在线')

  const controller = new AbortController()
  const running = service.attach(T2, ATTACH, { signal: controller.signal })
  await tick()
  controller.abort()
  gate.resolve()
  await assert.rejects(running, (error: unknown) => (error as { code?: string }).code === 'remote/cancelled')

  assert.equal(service.snapshot().connected, true, '连接回滚了')
  assert.equal(store.workspaces()[0]?.availability, 'offline', '投影没回滚：面板显示「已连接」但工作区全是离线')
})
