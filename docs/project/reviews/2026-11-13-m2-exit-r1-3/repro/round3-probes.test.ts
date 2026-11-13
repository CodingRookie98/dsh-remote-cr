/**
 * R1 #3（第三轮复审）夹具 · 2026-11-13 · M2 出口
 *
 * 三条实测 + 一条正向验证。**极性说明**：
 *   D1 / D2 —— 断言的是「缺陷成立」（绿 = 缺陷还在，与 R1 #1/#2 的夹具同风格）。
 *   P1      —— 断言的是「修复成立」（绿 = 这一轮真的堵住了），用于复核 R1 #2 N1。
 *
 * 跑法（仓库根）：
 *   node --test docs/project/reviews/2026-11-13-m2-exit-r1-3/repro/round3-probes.test.ts
 *
 * 只依赖产品代码 + 注入的假连接层，不需要真机、不需要 gcp、不占 3131/8961。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { registerTeleportRoutes, type TeleportHostContext } from '../../../../../src/local/api/routes.ts'
import { API_PREFIX } from '../../../../../src/shared/api.ts'
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

// ── D1：`hadReusable` 用「有没有任何连接」判定，不是「本次这条连接是否新建」────────
test('D1：先连 A、再接入 B 时取消 ⇒ 本次新建的 B 连接不被 dispose，取消后仍 connected', async () => {
  const store = new ProjectionStore()
  let disposedB = 0
  let calls = 0
  const gate = deferred<void>()
  const service = new ProjectionService({
    store,
    timers,
    async connect() {
      calls += 1
      if (calls === 1) {
        return { rpc: rpc(async (endpoint) => (endpoint === 'workspace/create' ? workspace('ws-a') : { items: [] })), dispose() {} }
      }
      return {
        rpc: rpc(async (endpoint) => {
          if (endpoint === 'workspace/create') {
            await gate.promise
            return workspace('ws-b')
          }
          return { items: [] }
        }),
        dispose() { disposedB += 1 },
      }
    },
  })

  await service.attach(T1, ATTACH)
  assert.equal(service.connected, true, '前提：先接入 A 成功，`#live` 已存在')

  const controller = new AbortController()
  const running = service.attach(T2, ATTACH, { signal: controller.signal })
  await tick()
  controller.abort()
  gate.resolve()
  await assert.rejects(running, (error: unknown) => (error as { code?: string }).code === 'remote/cancelled')

  // service.ts:218 的 `hadReusable = #live !== undefined || #detached !== undefined`
  // 在「切入另一个 target」时也为真，于是本次新建的连接既不 dispose 也不清 #live。
  assert.equal(disposedB, 0, '本次新建的 B 连接没有被 dispose（C5 换个入口又回来了）')
  assert.equal(service.connected, true, '取消之后 #live 仍指着 B，快照 link=connected')
  assert.deepEqual(service.snapshot().target, T2, '面板会显示「已连接到 B」，而请求回的是「已取消」')
})

// ── D2：`session/list` 失败 ⇒ 远端已建、本地一条不写 ─────────────────────────
test('D2：session/list 失败 ⇒ 远端工作区已建好，本地投影为空（重排写入时机的代价）', async () => {
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
          if (listCalls === 1) {
            throw new TeleportError({ code: 'remote/tunnel-unavailable', detail: 'boom', nextActions: [] })
          }
          return { items: [] }
        }),
        dispose() {},
      }
    },
  })

  await assert.rejects(service.attach(T1, ATTACH), (error: unknown) => (error as { code?: string }).code === 'remote/tunnel-unavailable')
  assert.equal(createCalls, 1, '远端 workspace/create 已经成功（远端有这条工作区）')
  assert.equal(store.workspaces().length, 0, '本地投影一条都没有 —— attach.ts:173-179 把 upsert 挪到了 session/list 之后')

  const second = await service.attach(T1, ATTACH)
  assert.equal(second.created, false, '再接入一次：远端幂等命中（本地`created` 也是 false）')
  assert.equal(store.workspaces().length, 1, '补上——所以「远端幂等吸收」只在用户**再接入一次**后成立')
})

// ── P1：/attach 的检查与置位之间没有 await（R1 #2 N1 的修复复核）──────────────
interface RouteRig {
  readonly call: (input: { path: string; body?: string; slowBody?: Promise<void> }) => Promise<{ status: number; json: unknown }>
}

function routeRig(service: ProjectionService): RouteRig {
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
  const call = async (input: { path: string; body?: string; slowBody?: Promise<void> }): Promise<{ status: number; json: unknown }> => {
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
      url: API_PREFIX + input.path,
      async *[Symbol.asyncIterator]() {
        if (input.slowBody !== undefined) await input.slowBody
        if (input.body !== undefined) yield Buffer.from(input.body)
      },
      destroy() {},
    } as never
    await routes.get(API_PREFIX + input.path)!(req, res)
    return { status, json: payload === '' ? undefined : JSON.parse(payload) }
  }
  return { call }
}

const ATTACH_BODY = JSON.stringify({
  target: { backend: 'ssh', alias: 'gcp', port: 8961, remoteRoot: '/home/hui/workspace' },
  remotePath: '/home/hui/workspace',
  localPath: 'C:/anchor/x',
})

test('P1：body 解析失败不占单飞槽；先到者被后到者顶掉后，仍在跑的那次可被取消', async () => {
  const gate = deferred<void>()
  const service = new ProjectionService({
    store: new ProjectionStore(),
    timers,
    connect: async () => ({
      rpc: rpc(async (endpoint) => {
        if (endpoint === 'workspace/create') {
          await gate.promise
          return workspace('ws-p1')
        }
        return { items: [] }
      }),
      dispose() {},
    }),
  })
  const rig = routeRig(service)

  // ① 坏 body：readJsonBody 在置位之前抛，槽位不该被占住
  const bad = await rig.call({ path: '/attach', body: '{not json' })
  assert.equal((bad.json as { ok?: boolean }).ok, false)
  const afterBad = await rig.call({ path: '/attach/cancel' })
  assert.deepEqual((afterBad.json as { value?: unknown }).value, { cancelled: false }, '坏 body 没有留下幽灵 controller')

  // ② 先到者还在读 body：后到者先置位并进 service；先到者随后被 attach-busy 拒掉
  const slow = deferred<void>()
  const first = rig.call({ path: '/attach', body: ATTACH_BODY, slowBody: slow.promise })
  await tick()
  const second = rig.call({ path: '/attach', body: ATTACH_BODY })
  await tick()
  slow.resolve()
  const firstResult = await first
  assert.equal((firstResult.json as { code?: string }).code, 'remote/attach-busy', '先点的那次被后到者顶掉（顺序反转）')

  // ③ 关键：仍在跑的那次必须可取消（R1 #2 N1 的缺陷形态是这里回 cancelled:false）
  const cancel = await rig.call({ path: '/attach/cancel' })
  assert.deepEqual((cancel.json as { value?: unknown }).value, { cancelled: true }, '在跑的那次拿到了 controller')
  gate.resolve()
  const secondResult = await second
  assert.equal((secondResult.json as { code?: string }).code, 'remote/cancelled', '那一次确实被取消，而不是建成工作区')
})
