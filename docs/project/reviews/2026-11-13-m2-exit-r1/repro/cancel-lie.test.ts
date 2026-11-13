/**
 * R1 复现夹具（2026-11-13，M2 出口审查）。
 *
 * 三个断言只依赖产品代码 + 注入的假连接层，不需要真机：
 *   1. signal 已 abort、连接层忽略它 ⇒ attach 照样成功（服务层没有自己的取消检查）
 *   2. 二次并发 attach ⇒ 先结束的那次把 #attach 清成 null，后一次仍在跑
 *   3. /attach/cancel 回 {cancelled:true} 之后，同一次 /attach 仍 200 建成工作区
 *
 * 跑法（仓库根）：node --test docs/project/reviews/2026-11-13-m2-exit-r1/repro/cancel-lie.test.ts
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { ProjectionService, type ConnectTarget } from '../../../../../src/local/projection/service.ts'
import { ProjectionStore } from '../../../../../src/local/projection/store.ts'
import type { ProjectionRpc, StreamEvent, StreamHandle } from '../../../../../src/local/projection/remote.ts'
import { registerTeleportRoutes, type TeleportHostContext } from '../../../../../src/local/api/routes.ts'
import { API_PREFIX } from '../../../../../src/shared/api.ts'

const TARGET: ConnectTarget = { backend: 'ssh', alias: 'gcp', port: 8961, remoteRoot: '/home/hui/workspace' }
const ATTACH = { remotePath: '/home/hui/workspace', localPath: 'C:/anchor/home/hui/workspace' }
const timers = { schedule: () => 0, cancel: () => {} }

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

function rpc(gate?: Promise<void>): ProjectionRpc {
  return {
    async call<T>(endpoint: string): Promise<T> {
      if (endpoint === 'workspace/create') {
        if (gate !== undefined) await gate
        return {
          workspace: { workspaceId: 'ws-1', path: TARGET.remoteRoot, title: 'w', sessionIds: [], createdAt: '', updatedAt: '' },
          created: true,
        } as T
      }
      if (endpoint === 'session/list') return { items: [] } as T
      throw new Error('unexpected ' + endpoint)
    },
    openStream(): StreamHandle {
      const events: StreamEvent[] = []
      return { cancel() {}, async *[Symbol.asyncIterator]() { for (const event of events) yield event } }
    },
  }
}

test('复现 1：signal 已 abort，连接层忽略它时 attach 仍然成功（没有任何一处抛 remote/cancelled）', async () => {
  const gate = deferred<void>()
  const controller = new AbortController()
  const service = new ProjectionService({
    store: new ProjectionStore(),
    timers,
    connect: async () => ({ rpc: rpc(gate.promise), dispose() {} }),
  })
  const running = service.attach(TARGET, ATTACH, { signal: controller.signal })
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  gate.resolve()
  const result = await running
  assert.equal(controller.signal.aborted, true, 'signal 已 abort')
  assert.equal(result.workspace.availability, 'online', '接入照样完成、工作区照样在线')
})

test('复现 2：并发两次 attach，先结束的那次把后一次的进度清成 null（面板显示「没在接入」）', async () => {
  const gateA = deferred<void>()
  const gateB = deferred<void>()
  let calls = 0
  const service = new ProjectionService({
    store: new ProjectionStore(),
    timers,
    connect: async () => {
      calls += 1
      return { rpc: rpc(calls === 1 ? gateA.promise : gateB.promise), dispose() {} }
    },
  })
  const first = service.attach(TARGET, ATTACH)
  await new Promise((resolve) => setImmediate(resolve))
  const second = service.attach({ ...TARGET, alias: 'other' }, ATTACH)
  await new Promise((resolve) => setImmediate(resolve))
  gateA.resolve()
  await first
  const midFlight = service.attachProgress
  gateB.resolve()
  await second
  assert.equal(midFlight, null, '后一次接入仍在跑，进度却已经是 null')
})

test('复现 3：/attach/cancel 回 cancelled:true 之后，同一次 /attach 仍 200 建成工作区', async () => {
  const gate = deferred<void>()
  const service = new ProjectionService({
    store: new ProjectionStore(),
    timers,
    connect: async () => ({ rpc: rpc(gate.promise), dispose() {} }),
  })
  const routes = new Map<string, (req: never, res: never) => Promise<void> | void>()
  const ctx = {
    webServer: {
      register(route: { path: string; handler: (req: never, res: never) => Promise<void> | void }) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    effect(run: () => unknown) { return run() },
  } as unknown as TeleportHostContext
  registerTeleportRoutes(ctx, {
    deps: {
      listSources: async () => ({ wslAvailable: false, distros: [], probeError: null, ssh: { configFile: '', readable: false, targets: [], problems: [] } }),
      listLocal: async () => ({ path: '.', entries: [], truncated: false, parent: null }),
      listDistro: async () => ({ path: '/', entries: [], truncated: false, parent: null }),
      probeFacts: async () => ({}),
      isDirectory: async () => true,
    } as never,
    wslExecutable: 'wsl.exe',
    projection: service,
  })
  const call = async (path: string, body?: string) => {
    let status = 0
    let payload = ''
    const res = {
      set statusCode(value: number) { status = value },
      get statusCode() { return status },
      setHeader() {},
      end(chunk?: string) { payload = chunk ?? '' },
    } as never
    const req = {
      socket: { remoteAddress: '127.0.0.1' },
      method: 'POST',
      url: API_PREFIX + path,
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(body) },
      destroy() {},
    } as never
    await routes.get(API_PREFIX + path)!(req, res)
    return { status, json: payload === '' ? undefined : JSON.parse(payload) }
  }
  const body = JSON.stringify({ target: { backend: 'ssh', alias: 'gcp', port: 8961, remoteRoot: '/home/hui/workspace' }, remotePath: '/home/hui/workspace', localPath: 'C:/anchor/x' })
  const attach = call('/attach', body)
  await new Promise((resolve) => setImmediate(resolve))
  const cancel = await call('/attach/cancel')
  gate.resolve()
  const finished = await attach
  assert.deepEqual(cancel.json, { ok: true, value: { cancelled: true } }, '取消回执说取消了')
  assert.equal(finished.status, 200, '同一次接入照样成功')
})
