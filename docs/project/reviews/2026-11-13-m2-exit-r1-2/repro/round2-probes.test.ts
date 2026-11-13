/**
 * R1 #2 复审夹具（2026-11-13，M2 出口 · 第二轮）。
 *
 * 五个断言只依赖产品代码 + 注入的假子进程 / 假连接层，不需要真机、不需要 gcp。
 * 每条都对应报告里的一个编号：
 *   C1  launch 段仍由 **stderr 第一行**触发（A8 所述「只认 stdout 首字节」不成立）
 *   C2  routes.ts 的 /attach 单飞是「先 await 再置位」⇒ 两个请求都能过检查，
 *       后置位者的 finally 把先跑者的 controller 清掉 ⇒ 正在跑的那次从此不可取消
 *   C3  取消落在 session/list 段：attach 抛 remote/cancelled，投影表却留下一条 online 工作区
 *   C4  runSsh 对「注册监听前就已经 abort」的 signal 完全不响应（launch.ts 有这道预检，
 *       transport.ts 没有）⇒ 取消落在两段之间时，下一段照跑
 *   C5  在 tunnel 段取消：连接已经建立，服务层抛 cancelled 却不清 #live、不 dispose，
 *       远端进程与隧道继续活着（落盘 sawBusy:true / portFreed:false 的代码侧解释）
 *
 * 跑法（仓库根）：
 *   node --test docs/project/reviews/2026-11-13-m2-exit-r1-2/repro/round2-probes.test.ts
 *
 * 每条断言断言的是**缺陷存在**（绿 = 缺陷成立），与 R1 的 cancel-lie.test.ts 同风格。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { registerTeleportRoutes, type TeleportHostContext } from '../../../../../src/local/api/routes.ts'
import { API_PREFIX } from '../../../../../src/shared/api.ts'
import { launchSshDsh, type SshLaunchChild, type SshLaunchSpawn } from '../../../../../src/local/backend/ssh/launch.ts'
import { runSsh, type SshChild } from '../../../../../src/local/backend/ssh/transport.ts'
import type { SshTarget } from '../../../../../src/local/backend/ssh/config.ts'
import type { ProjectionRpc, StreamEvent, StreamHandle } from '../../../../../src/local/projection/remote.ts'
import { ProjectionService, type ConnectTarget } from '../../../../../src/local/projection/service.ts'
import { ProjectionStore } from '../../../../../src/local/projection/store.ts'

const TARGET: ConnectTarget = { backend: 'ssh', alias: 'gcp', port: 8961, remoteRoot: '/home/hui/workspace' }
const ATTACH = { remotePath: '/home/hui/workspace', localPath: 'C:/anchor/home/hui/workspace' }
const timers = { schedule: () => 0, cancel: () => {} }
const SSH_TARGET: SshTarget = {
  alias: 'gcp',
  hostName: '10.0.0.9',
  user: 'hui',
  port: 22,
  identityFiles: [],
  proxyJump: [],
  source: { file: 'C:/Users/hui/.ssh/config', line: 3 },
}

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

// ── C1：launch 阶段由 stderr 触发 ────────────────────────────────────────────
class FakeLaunchChild {
  readonly stdinWrites: string[] = []
  readonly events = new EventEmitter()
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly stdin = {
    write: (chunk: string): boolean => { this.stdinWrites.push(chunk); return true },
    end: (): void => {},
  }
  on(event: string, listener: (...args: never[]) => void): this {
    this.events.on(event, listener as never)
    return this
  }
  kill(): boolean { return true }
  asChild(): SshLaunchChild { return this as unknown as SshLaunchChild }
}

test('C1：认证失败（只有 stderr，从没收到 stdout）也会把阶段推成 launch', async () => {
  const stages: string[] = []
  const spawn: SshLaunchSpawn = () => {
    const child = new FakeLaunchChild()
    setImmediate(() => {
      child.stderr.emit('data', Buffer.from('hui@10.0.0.9: Permission denied (publickey).\n'))
      child.events.emit('exit', 255, null)
      child.events.emit('close', 255, null)
    })
    return child.asChild()
  }
  const caught = await launchSshDsh({
    homeDir: 'D:/Temp/teleport-home',
    target: SSH_TARGET,
    auth: { kind: 'agent' },
    remoteRoot: '/home/hui/workspace',
    spawn,
    onStage: (stage) => stages.push(stage),
  }).then(() => null, (error: unknown) => error)
  assert.notEqual(caught, null, '认证失败必须抛错')
  assert.deepEqual(stages, ['launch'], 'stderr 第一行就把阶段推成了「启动远端 dsh」——而远端 dsh 从未启动')
})

// ── C2：/attach 单飞的检查与置位隔着一个 await ──────────────────────────────
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

test('C2：第二个 /attach 在第一个还在等请求体时进入 ⇒ 先跑者被置位者覆盖 ⇒ 正在跑的接入不可取消', async () => {
  const gate = deferred<void>()
  const service = new ProjectionService({
    store: new ProjectionStore(),
    timers,
    connect: async () => ({
      rpc: rpc(async (endpoint) => {
        if (endpoint === 'workspace/create') {
          await gate.promise
          return { workspace: { workspaceId: 'ws-1', path: TARGET.remoteRoot, title: 'w', sessionIds: [], createdAt: '', updatedAt: '' }, created: true }
        }
        return { items: [] }
      }),
      dispose() {},
    }),
  })
  const rig = routeRig(service)
  const slow = deferred<void>()
  const first = rig.call({ path: '/attach', body: ATTACH_BODY, slowBody: slow.promise })
  await tick()
  // 第二个请求体就绪 ⇒ 它先通过 attaching 检查、先落位 controller、先进入 service.attach
  const second = rig.call({ path: '/attach', body: ATTACH_BODY })
  await tick()
  // 第一个请求体到达 ⇒ 它覆盖 attaching，然后被 service 的 busy 拒掉，finally 把 attaching 清成 undefined
  slow.resolve()
  const firstResult = await first
  assert.deepEqual(
    (firstResult.json as { code?: string }).code,
    'remote/attach-busy',
    '第二个请求必须被显式拒绝（service 层拦住了双连）',
  )
  const cancel = await rig.call({ path: '/attach/cancel' })
  assert.deepEqual(
    (cancel.json as { value?: { cancelled?: boolean } }).value,
    { cancelled: false },
    '仍在进行的那次接入已经没有任何 controller 可取消 —— 单飞的检查与置位隔着 await',
  )
  gate.resolve()
  const secondResult = await second
  assert.equal(secondResult.status, 200, '不可取消的那次接入照样跑完并建成工作区')
})

// ── C3：取消落在 session/list 段 ────────────────────────────────────────────
test('C3：取消发生在 session/list 期间 ⇒ 抛 remote/cancelled，但投影表里留下一条 online 工作区', async () => {
  const store = new ProjectionStore()
  const controller = new AbortController()
  const gate = deferred<void>()
  const connection = {
    rpc: rpc(async (endpoint) => {
      if (endpoint === 'workspace/create') {
        return { workspace: { workspaceId: 'ws-late', path: TARGET.remoteRoot, title: 'w', sessionIds: [], createdAt: '', updatedAt: '' }, created: true }
      }
      await gate.promise
      return { items: [] }
    }),
    dispose() {},
  }
  const service = new ProjectionService({ store, timers, connect: async () => connection })
  const running = service.attach(TARGET, ATTACH, { signal: controller.signal })
  await tick()
  controller.abort()
  gate.resolve()
  await assert.rejects(running, (error: unknown) => (error as { code?: string }).code === 'remote/cancelled')
  assert.equal(store.workspaces().length, 1, '取消之后投影表里仍有一条工作区')
  assert.equal(store.workspaces()[0]?.availability, 'online', '而且是 online —— 面板会把它显示成一条可用条目')
})

// ── C4：signal 在注册监听之前就 abort ⇒ 完全不响应 ──────────────────────────
test('C4：runSsh 收到「已 abort」的 signal 时不取消（照跑并正常返回）', async () => {
  let killed = false
  const child: SshChild = {
    stdout: { on: () => undefined },
    stderr: { on: () => undefined },
    on: (event: string, listener: (...args: never[]) => void) => {
      if (event === 'exit') setImmediate(() => (listener as (code: number, signal: string | null) => void)(0, null))
      return undefined
    },
    kill: () => { killed = true; return true },
  }
  const result = await runSsh({
    target: SSH_TARGET,
    auth: { kind: 'agent' },
    command: ['sh', '-c', 'true'],
    signal: AbortSignal.abort(),
    spawn: () => child,
  })
  assert.equal(result.code, 0, '已经 abort 的 signal 被忽略：命令照跑、照常 resolve')
  assert.equal(killed, false, '子进程没有被杀掉')
})

// ── C5：在 tunnel 段取消 ⇒ #live 不清、远端不回收 ────────────────────────────
test('C5：在 tunnel 段取消 ⇒ 抛 remote/cancelled，但连接仍记为 connected 且从未 dispose', async () => {
  const controller = new AbortController()
  const gate = deferred<void>()
  let disposed = false
  const connection = {
    rpc: rpc(async () => ({ items: [] })),
    dispose() { disposed = true },
  }
  const service = new ProjectionService({
    store: new ProjectionStore(),
    timers,
    connect: async (_target, control) => {
      control?.onPhase?.('tunnel')
      await gate.promise
      return connection
    },
  })
  const running = service.attach(TARGET, ATTACH, { signal: controller.signal })
  await tick()
  controller.abort()
  gate.resolve()
  await assert.rejects(running, (error: unknown) => (error as { code?: string }).code === 'remote/cancelled')
  assert.equal(service.connected, true, '取消之后连接仍记在 #live 上（快照 link=connected）')
  assert.equal(service.link, 'connected')
  assert.equal(disposed, false, '刚建好的连接从未 dispose —— 远端 dsh 与隧道继续活着')
})
