import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type {
  DirListing,
  DistroInfo,
  RemoteFacts,
  SourceReport,
  SshSourceReport,
  WslDiagnosis,
  WslWakeResult,
} from '../../shared/api.ts'
import { API_PREFIX } from '../../shared/api.ts'
import { ProjectionService, type ConnectTarget, type SshConnectTarget } from '../projection/service.ts'
import { ProjectionHub } from '../projection/hub.ts'
import { ProjectionStore } from '../projection/store.ts'
import type { HostDeps, MountedRoute, RemoteCrHostContext } from './routes.ts'
import { RemoteCrError } from '../backend/errors.ts'
import { acquireWrite, releaseWrite } from '../plugin-sync/locks.ts'
import { defaultAnchorResolver, parseAddInput, parseAttachInput, registerRemoteCrRoutes, type SyncRoutesOptions } from './routes.ts'
import { resolveAnchorPath } from '../backend/ssh/anchor-runtime.ts'
import type { SshTarget } from '../backend/ssh/config.ts'

const DISTROS: DistroInfo[] = [
  { name: 'ubuntu_dev', state: 'Running', version: 2, isDefault: true },
]

const NO_SSH: SshSourceReport = {
  configFile: 'C:\\Users\\hui\\.ssh\\config',
  readable: false,
  targets: [],
  problems: [],
}

const FACTS: RemoteFacts = {
  nodeVersion: '24.22.1',
  glibcVersion: '2.39',
  hasTar: true,
  hasDshHome: true,
  dshHome: '/home/hui/.dsh',
}

const LOCAL_LISTING: DirListing = { path: 'D:\\work', entries: [], truncated: false, parent: 'D:\\' }

interface Call {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: string
  readonly json: unknown
}

interface FakeRes {
  readonly res: never
  read(): Call
  /** 模拟客户端断开：只有带事件方法的假 res 才有意义（见 fakeClosableRes）。 */
  close(): void
}

function fakeRes(): FakeRes {
  const headers: Record<string, string> = {}
  let status = 0
  let body = ''
  const res = {
    set statusCode(value: number) {
      status = value
    },
    get statusCode() {
      return status
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value
    },
    end(chunk?: string) {
      body = chunk ?? ''
    },
  }
  return {
    res: res as never,
    read: () => ({ status, headers, body, json: body === '' ? undefined : JSON.parse(body) }),
    close() {},
  }
}

/**
 * 带事件方法的假 res：用来验「客户端断开 → abort → kill wsl.exe」这条链。
 *
 * 为什么必须单独造：普通 fakeRes 没有 `on`/`off`，路由里 `closable` 恒为 false，
 * 于是把 `res.on('close', onClose)` 整行删掉、甚至删掉 abort 分支，全部单测仍然全绿
 * （R1D-7 实测 27/27）——取消能力等于零断言。
 */
function fakeClosableRes(): FakeRes {
  const headers: Record<string, string> = {}
  const listeners = new Set<() => void>()
  let status = 0
  let body = ''
  const res = {
    set statusCode(value: number) {
      status = value
    },
    get statusCode() {
      return status
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value
    },
    end(chunk?: string) {
      body = chunk ?? ''
    },
    on(event: string, listener: () => void) {
      if (event === 'close') listeners.add(listener)
      return res
    },
    off(event: string, listener: () => void) {
      if (event === 'close') listeners.delete(listener)
      return res
    },
  }
  return {
    res: res as never,
    read: () => ({ status, headers, body, json: body === '' ? undefined : JSON.parse(body) }),
    close: () => {
      for (const listener of [...listeners]) listener()
    },
  }
}

function fakeReq(input: {
  method?: string
  url: string
  address?: string
  body?: string
}): never {
  const chunks = input.body === undefined ? [] : [Buffer.from(input.body)]
  return {
    socket: { remoteAddress: input.address ?? '127.0.0.1' },
    method: input.method ?? 'GET',
    url: input.url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
    destroy() {},
  } as never
}

interface Rig {
  readonly deps: HostDeps
  readonly mounted: readonly MountedRoute[]
  call(input: { path: string; method?: string; address?: string; body?: string; query?: Record<string, string> }): Promise<Call>
}

function rig(
  overrides: Partial<HostDeps> = {},
  extra: {
    projection?: ProjectionService
    resolveAnchorPath?: (target: SshConnectTarget, remotePath: string) => Promise<string>
    homeDir?: string
    sync?: SyncRoutesOptions
    doctor?: { rootDir?: string; homeDir?: string }
    hub?: ProjectionHub
  } = {},
  makeRes: () => FakeRes = fakeRes,
): Rig {
  const calls: string[] = []
  const deps: HostDeps = {
    listSources: async (): Promise<SourceReport> => ({ wslAvailable: true, distros: DISTROS, probeError: null, ssh: NO_SSH }),
    listLocal: async (path) => {
      calls.push('local:' + path)
      return { ...LOCAL_LISTING, path }
    },
    listDistro: async (distro, path) => {
      calls.push('distro:' + distro + ':' + path)
      return { path, entries: [], truncated: false, parent: null }
    },
    probeFacts: async () => FACTS,
    isDirectory: async (path) => path !== 'D:\\nope',
    wakeDistro: async (distro) => ({ distro, ok: true, ms: 12, diagnosis: null }),
    ...overrides,
  }

  const routes = new Map<string, (req: never, res: never) => Promise<void> | void>()
  const effects: string[] = []
  const ctx: RemoteCrHostContext = {
    webServer: {
      register(route) {
        assert.equal(route.kind, 'exact', '全部路由必须是 exact，前缀会吃掉将来的子路径')
        assert.equal(routes.has(route.path), false, '重复注册同一路径会直接抛 webserver duplicate')
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    effect(execute, label) {
      effects.push(label)
      return execute()
    },
  }

  const mounted = registerRemoteCrRoutes(ctx, {
    deps,
    wslExecutable: 'wsl.exe',
    ...(extra.homeDir === undefined ? {} : { homeDir: extra.homeDir }),
    ...(extra.projection === undefined ? {} : { projection: extra.projection }),
    ...(extra.resolveAnchorPath === undefined ? {} : { resolveAnchorPath: extra.resolveAnchorPath }),
    ...(extra.sync === undefined ? {} : { sync: extra.sync }),
    ...(extra.doctor === undefined ? {} : { doctor: extra.doctor }),
    ...(extra.hub === undefined ? {} : { hub: extra.hub }),
  })
  assert.deepEqual(effects.length, mounted.length, '每条路由恰好一个 effect')

  return {
    deps,
    mounted,
    async call(input) {
      const url = new URL(API_PREFIX + input.path, 'http://remote-cr.invalid')
      for (const [key, value] of Object.entries(input.query ?? {})) url.searchParams.set(key, value)
      const handler = routes.get(url.pathname)
      assert.notEqual(handler, undefined, '没有挂载 ' + url.pathname)
      const { res, read } = makeRes()
      await handler?.(
        fakeReq({
          url: url.pathname + url.search,
          ...(input.method === undefined ? {} : { method: input.method }),
          ...(input.address === undefined ? {} : { address: input.address }),
          ...(input.body === undefined ? {} : { body: input.body }),
        }),
        res,
      )
      return read()
    },
  }
}

test('全部路由都挂载在 /remote-cr/api 下，且各自声明允许的 method', () => {
  const { mounted } = rig()
  assert.deepEqual(
    mounted.map((route) => route.path + ' ' + route.allowed.join('|')).sort(),
    [
      '/remote-cr/api/anchors GET',
      '/remote-cr/api/attach POST',
      '/remote-cr/api/attach/cancel POST',
      '/remote-cr/api/disconnect POST',
      '/remote-cr/api/doctor GET',
      '/remote-cr/api/flow GET',
      '/remote-cr/api/flow/cancel POST',
      '/remote-cr/api/list GET',
      '/remote-cr/api/maintenance/purge POST',
      '/remote-cr/api/maintenance/residue GET',
      '/remote-cr/api/plugin-sync GET|POST',
      '/remote-cr/api/plugin-sync/host POST',
      '/remote-cr/api/plugin-sync/optout GET|POST',
      '/remote-cr/api/plugin-sync/progress GET',
      '/remote-cr/api/probe POST',
      '/remote-cr/api/projection GET',
      '/remote-cr/api/projection/refresh POST',
      '/remote-cr/api/projection/targets GET',
      '/remote-cr/api/reconnect POST',
      '/remote-cr/api/session POST',
      '/remote-cr/api/sources GET',
  '/remote-cr/api/stop POST',
      '/remote-cr/api/workspace POST',
  '/remote-cr/api/workspace/import POST',
  '/remote-cr/api/workspace/importable GET',
      '/remote-cr/api/workspaces GET',
      '/remote-cr/api/wsl/wake POST',
    ],
  )
})


// ── 多 host 容器（RFC-0007 A1）────────────────────────────────────────────

test('/disconnect?target=：只断开指定那台，不动 focus（P4 A3-B2）', async () => {
  const calls: string[] = []
  const makeStub = (name: string): ProjectionService =>
    ({
      attach: async () => ({ created: true, workspace: {}, sessions: [] }),
      disconnect: () => {
        calls.push(name)
      },
      snapshot: () => ({
        workspaces: [],
        sessions: [],
        connected: false,
        target: null,
        link: 'idle',
        envPolicy: null,
        attach: null,
        stale: false,
      }),
    }) as unknown as ProjectionService
  let created = 0
  const hub2 = new ProjectionHub(() => {
    const service = makeStub(String(created))
    created += 1
    return service
  })
  const A2: ConnectTarget = { backend: 'ssh', alias: 'demo', port: 22, remoteRoot: '/home/hui/a' }
  const B2: ConnectTarget = { backend: 'ssh', alias: 'demo', port: 22, remoteRoot: '/home/hui/b' }
  await hub2.attach(A2, { remotePath: '/a', localPath: 'C:/a' })
  await hub2.attach(B2, { remotePath: '/b', localPath: 'C:/b' })
  calls.length = 0
  const result = await rig({}, { hub: hub2 }).call({
    path: '/disconnect',
    method: 'POST',
    body: JSON.stringify({ target: A2 }),
  })
  assert.equal(result.status, 200)
  assert.equal(calls.includes('0'), true, '必须断开 A 自己那个引擎')
  assert.equal(calls.includes('1'), false, '不许断到 focus（B）')
})


test('/projection/targets：没有容器时给空数组（不是 404、也不是 null）', async () => {
  const result = await rig().call({ path: '/projection/targets' })
  const envelope = result.json as { ok: boolean; value?: unknown[] }
  assert.equal(envelope.ok, true)
  assert.deepEqual(envelope.value, [])
})

test('/projection?target=：没接过的目标要结构化报错，不静默回落到另一台', async () => {
  const result = await rig({}, { projection: new ProjectionService({ store: new ProjectionStore(), connect: async () => { throw new Error('不该连') } }) }).call({
    path: '/projection',
    query: { target: JSON.stringify(SYNC_TARGET) },
  })
  const envelope = result.json as { ok: boolean; code?: string }
  assert.equal(envelope.ok, false)
  assert.equal(envelope.code, 'remote/unknown')
})

// ── 远端残留（RFC-0006 Phase 2）──────────────────────────────────────────

/**
 * 维护面的假执行面：**按脚本内容**回应——盘点、判活、清理是三次不同的 exec，
 * 用一个固定 stdout 糊过去会让「解析判活结果」这条链完全没被测到。
 */
function maintenanceSync(calls: string[], replies: { residue?: string; alive?: string; purge?: string; aliveCode?: number }): SyncRoutesOptions {
  return {
    optoutFile: 'x',
    localProfileDir: 'y',
    targetId: async () => 'test-target-id',
    resolve: async () => ({
      nodeCommand: '/usr/bin/node',
      dshCommand: '/usr/bin/dsh',
      nodeBin: '/usr/bin',
      homeDir: '',
      stagingSuffix: '.dsh-remote-cr/staging/abc123',
      exec: async (script: string) => {
        calls.push(script)
        if (script.includes('for p in')) return { code: replies.aliveCode ?? 0, stdout: replies.alive ?? 'DONE=1', stderr: '' }
        if (script.includes('rm -rf') || script.includes('rm -f')) return { code: 0, stdout: replies.purge ?? 'DONE=1', stderr: '' }
        return { code: 0, stdout: replies.residue ?? 'DONE=1', stderr: '' }
      },
    }),
  }
}

const RESIDUE_STDOUT = [
  'STAGING=/home/hui/.dsh-remote-cr/staging/abc123',
  'STAGING_EXISTS=1',
  'STAGING_KB=2048',
  'INSTANCES=/home/hui/.dsh-remote-cr/instances',
  'INSTANCE_BEGIN=live.json|4',
  '{"version":1,"pid":4242}',
  'INSTANCE_END',
  'DONE=1',
].join('\n')

test('/maintenance/residue：盘点 + 判活，路径只由 $HOME 拼（RFC-0006 R3/N0）', async () => {
  const calls: string[] = []
  const result = await rig({}, { sync: maintenanceSync(calls, { residue: RESIDUE_STDOUT, alive: 'ALIVE=4242\nDONE=1\n' }) }).call({
    path: '/maintenance/residue',
    query: { target: JSON.stringify(SYNC_TARGET) },
  })
  const envelope = result.json as { ok: boolean; value?: { staging: { kb: number }; instances: { files: { alive: boolean; pid: number }[] } } }
  assert.equal(result.status, 200)
  assert.equal(envelope.ok, true, JSON.stringify(result.json))
  assert.equal(envelope.value?.staging.kb, 2048)
  assert.deepEqual(envelope.value?.instances.files, [{ name: 'live.json', kb: 4, pid: 4242, version: 1, alive: true }])
  assert.equal(calls.length, 2, '盘点 + 判活两次只读 exec')
  assert.equal(/\/home\/hui/.test(calls[0] ?? ''), false, '脚本里不许出现具体 home（v1 的 N0）')
})

test('/maintenance/purge：没有 confirm 直接拒绝，且一次 exec 都不发（R4）', async () => {
  const calls: string[] = []
  const result = await rig({}, { sync: maintenanceSync(calls, {}) }).call({
    path: '/maintenance/purge',
    method: 'POST',
    body: JSON.stringify({ target: SYNC_TARGET }),
  })
  const envelope = result.json as { ok: boolean; code?: string }
  assert.equal(envelope.ok, false)
  assert.equal(envelope.code, 'remote/maintenance-confirm-required')
  assert.equal(calls.length, 0, '未确认时不许碰远端')
})

test('/maintenance/purge：目标正连着时拒绝，且一次 exec 都不发（R4）', async () => {
  const projection = {
    snapshot: () => ({ connected: true, target: SYNC_TARGET }),
  } as unknown as ProjectionService
  const calls: string[] = []
  const result = await rig({}, { projection, sync: maintenanceSync(calls, {}) }).call({
    path: '/maintenance/purge',
    method: 'POST',
    body: JSON.stringify({ target: SYNC_TARGET, confirm: true }),
  })
  const envelope = result.json as { ok: boolean; code?: string }
  assert.equal(envelope.code, 'remote/maintenance-busy')
  assert.equal(calls.length, 0, '连接中不许动远端文件')
})

test('/maintenance/purge：别的写者持锁时拒绝，且一次 exec 都不发（N4）', async () => {
  const calls: string[] = []
  const lock = acquireWrite('test-target-id', 'host')
  assert.equal(lock.ok, true)
  try {
    const result = await rig({}, { sync: maintenanceSync(calls, {}) }).call({
      path: '/maintenance/purge',
      method: 'POST',
      body: JSON.stringify({ target: SYNC_TARGET, confirm: true }),
    })
    const envelope = result.json as { ok: boolean; code?: string }
    assert.equal(envelope.code, 'remote/maintenance-locked')
    assert.equal(calls.length, 0)
  } finally {
    releaseWrite('test-target-id')
  }
})

test('/maintenance/purge：删除失败必须上报，不许报「已清理」（N3）', async () => {
  const residue = [
    'STAGING=/home/hui/.dsh-remote-cr/staging/abc123',
    'STAGING_EXISTS=1',
    'STAGING_KB=2048',
    'INSTANCES=/home/hui/.dsh-remote-cr/instances',
    'DONE=1',
  ].join('\n')
  const result = await rig({}, { sync: maintenanceSync([], { residue, purge: 'FAILED_STAGING=/s/abc\nDONE=1\n' }) }).call({
    path: '/maintenance/purge',
    method: 'POST',
    body: JSON.stringify({ target: SYNC_TARGET, confirm: true }),
  })
  const envelope = result.json as { ok: boolean; code?: string }
  assert.equal(envelope.code, 'remote/maintenance-failed')
})

test('/maintenance/residue：判活 exec 失败时整体失败，不把活登记报成已死（N1）', async () => {
  const residue = [
    'STAGING=/home/hui/.dsh-remote-cr/staging/abc123',
    'STAGING_EXISTS=1',
    'STAGING_KB=1',
    'INSTANCES=/home/hui/.dsh-remote-cr/instances',
    'INSTANCE_BEGIN=live.json|4',
    '{"version":1,"pid":4242}',
    'INSTANCE_END',
    'DONE=1',
  ].join('\n')
  const result = await rig({}, { sync: maintenanceSync([], { residue, aliveCode: 1 }) }).call({
    path: '/maintenance/residue',
    query: { target: JSON.stringify(SYNC_TARGET) },
  })
  const envelope = result.json as { ok: boolean; code?: string }
  assert.equal(envelope.code, 'remote/maintenance-failed')
})

test('/maintenance/purge：同 distro 不同 remoteRoot 也算「正连着」（WSL 的 staging 是 distro 级）', async () => {
  const CONNECTED_WSL = { backend: 'wsl' as const, distro: 'Ubuntu-24.04', port: 8899, remoteRoot: '/home/hui/a' }
  const OTHER_WSL = { backend: 'wsl' as const, distro: 'ubuntu-24.04', port: 8899, remoteRoot: '/home/hui/b' }
  const projection = { snapshot: () => ({ connected: true, target: CONNECTED_WSL }) } as unknown as ProjectionService
  const calls: string[] = []
  const result = await rig({}, { projection, sync: maintenanceSync(calls, {}) }).call({
    path: '/maintenance/purge',
    method: 'POST',
    body: JSON.stringify({ target: OTHER_WSL, confirm: true }),
  })
  const envelope = result.json as { ok: boolean; code?: string }
  assert.equal(envelope.code, 'remote/maintenance-busy')
  assert.equal(calls.length, 0, '同 distro 换目录也不许删 distro 级 staging')
})

test('/maintenance/purge：有活驻留实例时应答带 skipped，且清理脚本里没有 rm -rf（P1 的路由层判据）', async () => {
  const residue = [
    'STAGING=/home/hui/.dsh-remote-cr/staging/abc123',
    'STAGING_EXISTS=1',
    'STAGING_KB=2048',
    'INSTANCES=/home/hui/.dsh-remote-cr/instances',
    'INSTANCE_BEGIN=abc123.json|4',
    '{"version":1,"pid":4242}',
    'INSTANCE_END',
    'DONE=1',
  ].join('\n')
  const calls: string[] = []
  const result = await rig({}, { sync: maintenanceSync(calls, { residue, alive: 'ALIVE=4242\nDONE=1\n' }) }).call({
    path: '/maintenance/purge',
    method: 'POST',
    body: JSON.stringify({ target: SYNC_TARGET, confirm: true }),
  })
  const envelope = result.json as { ok: boolean; value?: { skipped?: string } }
  assert.equal(envelope.ok, true, JSON.stringify(result.json))
  assert.equal(envelope.value?.skipped, 'resident-alive')
  assert.equal((calls[2] ?? '').includes('rm -rf'), false, '有活实例时清理脚本里不该出现 rm -rf')
})

test('/maintenance/purge：确认且未连接时先盘点再清理，返回删除清单（R4）', async () => {
  const calls: string[] = []
  const purgeOut = 'REMOVED_STAGING=/home/hui/.dsh-remote-cr/staging/abc123|2048\nREMOVED_INSTANCE=dead.json|4\nDONE=1\n'
  const residue = [
    'STAGING=/home/hui/.dsh-remote-cr/staging/abc123',
    'STAGING_EXISTS=1',
    'STAGING_KB=2048',
    'INSTANCES=/home/hui/.dsh-remote-cr/instances',
    'INSTANCE_BEGIN=dead.json|4',
    '{"version":1,"pid":999999}',
    'INSTANCE_END',
    'DONE=1',
  ].join('\n')
  const result = await rig({}, { sync: maintenanceSync(calls, { residue, alive: 'DONE=1\n', purge: purgeOut }) }).call({
    path: '/maintenance/purge',
    method: 'POST',
    body: JSON.stringify({ target: SYNC_TARGET, confirm: true }),
  })
  const envelope = result.json as { ok: boolean; value?: { removed: { kind: string }[]; freedKb: number } }
  assert.equal(envelope.ok, true, JSON.stringify(result.json))
  assert.equal(envelope.value?.removed.length, 2)
  assert.equal(envelope.value?.freedKb, 2052)
  assert.equal(calls.length, 3, '盘点 + 判活 + 清理')
  assert.ok(calls[2]?.includes('rm -rf'), '第三次才是清理脚本')
})
// ── 诊断（RFC-0005）────────────────────────────────────────────────────────

function doctorFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'remote-cr-doctor-'))
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'fixture-plugin',
      version: '1.2.3',
      main: 'lib/index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' }, engines: { dsh: '>=0.2.1-rc.0 <0.3.0' } },
    }),
  )
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'lib', 'index.js'), 'module.exports = {}')
  writeFileSync(join(root, 'lib', 'client.js'), 'module.exports = {}')
  writeFileSync(join(root, 'cordis.patch.yml'), 'rows: []')
  return root
}

test('/doctor：跑既有 runDoctor，报告首行与 CLI 同款（RFC-0005 R1/R2）', async () => {
  const rootDir = doctorFixture()
  const homeDir = mkdtempSync(join(tmpdir(), 'remote-cr-doctor-home-'))
  const result = await rig({}, { doctor: { rootDir, homeDir } }).call({ path: '/doctor' })
  const envelope = result.json as { ok: boolean; value?: { checks: { id: string; status: string; detail: string }[]; report: string } }
  assert.equal(result.status, 200)
  assert.equal(envelope.ok, true, JSON.stringify(result.json))
  const value = envelope.value
  assert.ok(value !== undefined)
  assert.ok(value.checks.length >= 3, '至少要 package / entry / state-root 三项')
  assert.ok(value.checks.some((check) => check.id === 'package' && check.detail === 'fixture-plugin@1.2.3'))
  assert.equal(value.report.split('\n')[0], 'dsh-remote-cr doctor', '报告必须是 CLI 同一份格式化')
})

test('/doctor：不注入 rootDir 时读的是包根（installedRoot）', async () => {
  const result = await rig().call({ path: '/doctor' })
  const envelope = result.json as { ok: boolean; value?: { checks: { id: string; status: string }[] } }
  const value = envelope.value
  assert.ok(value !== undefined)
  const pkg = value.checks.find((check) => check.id === 'package')
  assert.ok(pkg !== undefined && pkg.status === 'ok', '仓库根的 package.json 必须读得到：' + JSON.stringify(pkg))
})

// ── 插件同步路由（RFC-0003 / T4）────────────────────────────────────────────

function syncRig(overrides: Partial<SyncRoutesOptions> = {}): { rig: ReturnType<typeof rig>; optoutFile: string; calls: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'remote-cr-sync-'))
  const optoutFile = join(dir, 'sync-optout.json')
  const calls: string[] = []
  const rigged = rig({}, {
    sync: {
      optoutFile,
      localProfileDir: join(dir, 'profile'),
      targetId: async () => 'test-target-id',
      resolve: async () => ({
        nodeCommand: '/s/bin/node',
        dshCommand: '/s/npm/bin/dsh',
        nodeBin: '/s/bin',
        homeDir: '/home/hui',
        exec: async (script: string) => {
          calls.push(script)
          return { code: 0, stdout: JSON.stringify({ ok: true, bundles: [] }), stderr: '' }
        },
      }),
      ...overrides,
    },
  })
  return { rig: rigged, optoutFile, calls }
}

const SYNC_TARGET = { backend: 'ssh', alias: 'demo', port: 22, remoteRoot: '/home/hui/workspace' }

test('未接线：/plugin-sync 明确报 plugin-sync-read-failed，而不是回空 plan', async () => {
  const result = await rig().call({ path: '/plugin-sync', query: { target: JSON.stringify(SYNC_TARGET) } })
  // 错误信封是**扁平的**：{ ok:false, code, detail, nextActions }（envelope.ts）
  const envelope = result.json as { ok: boolean; code?: string }
  assert.equal(envelope.ok, false)
  assert.equal(envelope.code, 'remote/plugin-sync-read-failed')
})

test('/plugin-sync GET：只打一次远端 exec，返回 plan 与 totals', async () => {
  const { rig: r, calls } = syncRig()
  const result = await r.call({ path: '/plugin-sync', query: { target: JSON.stringify(SYNC_TARGET) } })
  const envelope = result.json as { ok: boolean; value?: { entries: unknown[]; totals: { install: number }; muted: boolean } }
  assert.equal(result.status, 200)
  assert.equal(envelope.ok, true)
  assert.deepEqual(envelope.value?.totals, { install: 0, upToDate: 0, skipped: 0 })
  assert.equal(envelope.value?.muted, false)
  assert.equal(calls.length, 1, 'GET 只允许一次远端 exec')
})

test('/plugin-sync GET：客户端带 profile 参数改不了读哪个 profile（R2-S1）', async () => {
  const { rig: r } = syncRig()
  const result = await r.call({
    path: '/plugin-sync',
    query: { target: JSON.stringify(SYNC_TARGET), profile: 'admin' },
  })
  const envelope = result.json as { ok: boolean; value?: { profile: string } }
  assert.equal(envelope.ok, true, JSON.stringify(result.json))
  assert.equal(envelope.value?.profile, 'web', 'profile 只由宿主配置决定，查询参数一律忽略')
})

test('/plugin-sync/optout：POST 静音后 GET 能读回，且按 target 粒度', async () => {
  const { rig: r } = syncRig()
  const posted = await r.call({ path: '/plugin-sync/optout', method: 'POST', body: JSON.stringify({ target: SYNC_TARGET, muted: true }) })
  const postEnvelope = posted.json as { value: { targets: string[] } }
  assert.deepEqual(postEnvelope.value.targets, ['test-target-id'], '静音粒度来自 targetId 注入（SSH 是 host+user+port 的 hash）')
  const got = await r.call({ path: '/plugin-sync/optout' })
  assert.deepEqual((got.json as { value: { targets: string[] } }).value.targets, ['test-target-id'])
})

test('/plugin-sync POST：没选任何项时给 plugin-sync-unsupported，且不执行命令', async () => {
  const { rig: r, calls } = syncRig()
  const result = await r.call({ path: '/plugin-sync', method: 'POST', body: JSON.stringify({ target: SYNC_TARGET, names: [] }) })
  const envelope = result.json as { ok: boolean; code?: string }
  assert.equal(envelope.ok, false, JSON.stringify(result.json))
  assert.equal(envelope.code, 'remote/plugin-sync-unsupported', JSON.stringify(result.json))
  assert.equal(calls.length, 0)
})

// ── 宿主版本对齐路由（H 系列，只做 registry 路径）────────────────────────────

function hostRig(input: {
  readonly runtime?: unknown
  readonly dshVersion?: string | null
  readonly hostVersion?: string | null
}): { rig: ReturnType<typeof rig>; calls: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'remote-cr-host-'))
  const calls: string[] = []
  const runtime = input.runtime ?? {
    homeDir: '/home/hui',
    nodeCommand: '/usr/bin/node',
    nodeBin: '/usr/bin',
    dshCommand: '/s/npm/bin/dsh',
    interpreter: null,
    dshRoot: '/home/hui/.dsh-remote-cr/staging/abc',
    source: 'staging',
  }
  const payload = JSON.stringify({ ok: true, bundles: [], runtime, dshVersion: input.dshVersion ?? '0.2.1-rc.5' })
  const rigged = rig({}, {
    sync: {
      optoutFile: join(dir, 'sync-optout.json'),
      localProfileDir: join(dir, 'profile'),
      targetId: async () => 'test-target-id',
      resolve: async () => ({
        nodeCommand: '/usr/bin/node',
        dshCommand: '/s/npm/bin/dsh',
        nodeBin: '/usr/bin',
        homeDir: '/home/hui',
        hostVersion: input.hostVersion ?? '0.2.2-rc.4',
        supported: (version: string) => version.startsWith('0.2.'),
        exec: async (script: string) => {
          calls.push(script)
          // 第 1 次：读 profile；第 2 次：registry 探测；第 3 次：安装。
          if (calls.length === 1) return { code: 0, stdout: payload, stderr: '' }
          if (calls.length === 2) return { code: 0, stdout: '0.2.2-rc.4', stderr: '' }
          return { code: 0, stdout: '0.2.2-rc.4\nREMOTE_CR_DSH_OK\n', stderr: '' }
        },
      }),
    },
  })
  return { rig: rigged, calls }
}

test('/plugin-sync/host POST：align 时先探测 registry 再装，命令带确切版本', async () => {
  const { rig: r, calls } = hostRig({})
  const result = await r.call({ path: '/plugin-sync/host', method: 'POST', body: JSON.stringify({ target: SYNC_TARGET }) })
  const envelope = result.json as { ok: boolean; value?: { version: string; restartRequired: boolean } }
  assert.equal(envelope.ok, true, JSON.stringify(result.json))
  assert.equal(envelope.value?.version, '0.2.2-rc.4')
  assert.equal(envelope.value?.restartRequired, true, '装完必须重连才生效，这条要能传到 UI')
  assert.equal(calls.length, 3, '读 plan + registry 探测 + 安装')
  assert.match(calls[1] ?? '', /view '@deepseek-ai\/dsh@0\.2\.2-rc\.4' version/)
  assert.match(calls[2] ?? '', /install --global --no-audit --no-fund '@deepseek-ai\/dsh@0\.2\.2-rc\.4'/)
})

test('/plugin-sync/host POST：远端是检出 → 拒绝，且**只**读了 plan（不装任何东西）', async () => {
  const { rig: r, calls } = hostRig({
    runtime: { homeDir: '/home/hui', nodeCommand: '/usr/bin/node', nodeBin: '/usr/bin', dshCommand: '/w/bin.js', interpreter: '/usr/bin/node', dshRoot: '/w', source: 'checkout' },
  })
  const result = await r.call({ path: '/plugin-sync/host', method: 'POST', body: JSON.stringify({ target: SYNC_TARGET }) })
  const envelope = result.json as { ok: boolean; code?: string; detail?: string }
  assert.equal(envelope.ok, false)
  assert.equal(envelope.code, 'remote/host-sync-rejected', '拒绝要对应用户能懂的独立码')
  assert.match(String(envelope.detail), /checkout-mode/, '拒绝理由要带原因码，不能只说「不行」')
  assert.equal(calls.length, 1, '拒绝时不许探测 registry，更不许安装')
})

test('/plugin-sync/host POST：版本已一致 → 拒绝（不做无意义的安装）', async () => {
  const { rig: r, calls } = hostRig({ dshVersion: '0.2.2-rc.4' })
  const result = await r.call({ path: '/plugin-sync/host', method: 'POST', body: JSON.stringify({ target: SYNC_TARGET }) })
  const envelope = result.json as { ok: boolean; code?: string }
  assert.equal(envelope.ok, false)
  assert.equal(envelope.code, 'remote/host-sync-rejected')
  assert.equal(calls.length, 1)
})

test('/plugin-sync/host POST：同一 target 并发升级只放行一个（否则两路 npm install 互踩）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-cr-host-lock-'))
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  let installs = 0
  const payload = JSON.stringify({
    ok: true,
    bundles: [],
    dshVersion: '0.2.1-rc.5',
    runtime: { homeDir: '/home/hui', nodeCommand: '/usr/bin/node', nodeBin: '/usr/bin', dshCommand: '/s/npm/bin/dsh', interpreter: null, dshRoot: '/s', source: 'staging' },
  })
  const r = rig({}, {
    sync: {
      optoutFile: join(dir, 'sync-optout.json'),
      localProfileDir: join(dir, 'profile'),
      targetId: async () => 'same-target',
      resolve: async () => ({
        nodeCommand: '/usr/bin/node', dshCommand: '/s/npm/bin/dsh', nodeBin: '/usr/bin', homeDir: '/home/hui',
        hostVersion: '0.2.2-rc.4', supported: (v: string) => v.startsWith('0.2.'),
        exec: async (script: string) => {
          if (script.includes('view ')) { installs += 1; await gate; return { code: 0, stdout: '0.2.2-rc.4', stderr: '' } }
          if (script.includes('install --global')) return { code: 0, stdout: '0.2.2-rc.4\nREMOTE_CR_DSH_OK\n', stderr: '' }
          return { code: 0, stdout: payload, stderr: '' }
        },
      }),
    },
  })
  const first = r.call({ path: '/plugin-sync/host', method: 'POST', body: JSON.stringify({ target: SYNC_TARGET }) })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const second = await r.call({ path: '/plugin-sync/host', method: 'POST', body: JSON.stringify({ target: SYNC_TARGET }) })
  const envelope = second.json as { ok: boolean; detail?: string }
  assert.equal(envelope.ok, false)
  assert.match(String(envelope.detail), /已经在升级宿主/)
  assert.equal((envelope as { code?: string }).code, 'remote/plugin-sync-busy')
  assert.equal(installs, 1, '第二个请求不许再发一次 registry 探测')
  release?.()
  const done = await first
  assert.equal((done.json as { ok: boolean }).ok, true)
})

test('/plugin-sync/host POST：插件同步占着锁时拒绝，且连 plan 都不读（R1-B1）', async () => {
  const { rig: r, calls } = hostRig({})
  acquireWrite('test-target-id', 'apply')
  try {
    const result = await r.call({ path: '/plugin-sync/host', method: 'POST', body: JSON.stringify({ target: SYNC_TARGET }) })
    const envelope = result.json as { ok: boolean; code?: string; detail?: string }
    assert.equal(envelope.ok, false)
    assert.equal(envelope.code, 'remote/plugin-sync-busy')
    assert.match(String(envelope.detail), /正在同步插件/)
    assert.equal(calls.length, 0, '拿不到锁时连 plan 都不该读')
  } finally {
    releaseWrite('test-target-id')
  }
})

test('没有接入在进行时点取消：回 200 且 cancelled=false，不当成错误', async () => {
  const result = await rig().call({ path: '/attach/cancel', method: 'POST' })
  assert.equal(result.status, 200)
  assert.deepEqual((result.json as { value: { cancelled: boolean } }).value, { cancelled: false })
})

test('/sources 回四选一 + 可点清单；探测失败也回 200（灰显不是错误）', async () => {
  const ok = await rig().call({ path: '/sources' })
  assert.equal(ok.status, 200)
  const value = (ok.json as { value: { options: unknown[]; selectable: string[] } }).value
  assert.equal(value.options.length, 4)
  assert.deepEqual(value.selectable, ['local', 'wsl'])

  const degraded = await rig({
    listSources: async () => ({ wslAvailable: false, distros: [], probeError: 'wsl.exe 不存在', ssh: NO_SSH }),
  }).call({ path: '/sources' })
  assert.equal(degraded.status, 200, '没装 WSL 是正常情况，不能回 5xx')
  const degradedValue = (degraded.json as { value: { selectable: string[]; probeError: string } }).value
  assert.deepEqual(degradedValue.selectable, ['local'])
  assert.equal(degradedValue.probeError, 'wsl.exe 不存在')

  // 装了 WSL 但一个发行版都没有：原因必须与「没装 WSL」不同（RFC-0001 §6 前两行），
  // 这条断言同时证明 wslDistroCount 真的被传进了 sourceOptions。
  const noDistro = await rig({
    listSources: async () => ({ wslAvailable: false, distros: [], probeError: null, ssh: NO_SSH }),
  }).call({ path: '/sources' })
  const noDistroOptions = (noDistro.json as { value: { options: { id: string; reasonId: string }[] } }).value.options
  assert.equal(
    noDistroOptions.find((option) => option.id === 'wsl')?.reasonId,
    'wsl-no-distro',
    '共享层只回 id：文案由客户端字典渲染（ADR-0007）',
  )
})

test('/list 不带 distro 走本机，带 distro 走发行版（两条分支都要真的分叉）', async () => {
  const local = await rig().call({ path: '/list', query: { path: 'D:\\work' } })
  assert.equal((local.json as { value: DirListing }).value.path, 'D:\\work')

  const distro = await rig().call({ path: '/list', query: { distro: 'ubuntu_dev', path: '/home/hui' } })
  assert.equal((distro.json as { value: DirListing }).value.path, '/home/hui')
})

test('/list 不带 path 时给默认起点：本机是用户主目录，发行版是 /', async () => {
  const seen: string[] = []
  const capture = rig({
    listLocal: async (path) => {
      seen.push('local:' + path)
      return { ...LOCAL_LISTING, path }
    },
    listDistro: async (distro, path) => {
      seen.push('distro:' + distro + ':' + path)
      return { path, entries: [], truncated: false, parent: null }
    },
  })
  await capture.call({ path: '/list' })
  await capture.call({ path: '/list', query: { distro: 'ubuntu_dev' } })
  assert.equal(seen.length, 2)
  assert.match(seen[0] as string, /^local:/)
  assert.equal(seen[1], 'distro:ubuntu_dev:/')
})

test('/workspace 立刻回 running 快照；随后 /flow 能查到同一个 id', async () => {
  const r = rig()
  const started = await r.call({ path: '/workspace', method: 'POST', body: JSON.stringify({ source: 'local', path: 'D:\\work' }) })
  assert.equal(started.status, 200)
  const snapshot = (started.json as { value: { id: string; state: { status: string } } }).value
  assert.equal(snapshot.state.status, 'running', '必须立刻回 running，否则用户按不了取消')

  const polled = await r.call({ path: '/flow', query: { id: snapshot.id } })
  const polledValue = (polled.json as { value: { id: string } }).value
  assert.equal(polledValue.id, snapshot.id)
})

test('/workspace 的路径不可读时，流程落 failed 但 HTTP 仍是 200 信封', async () => {
  const r = rig()
  const started = await r.call({ path: '/workspace', method: 'POST', body: JSON.stringify({ source: 'local', path: 'D:\\nope' }) })
  const id = (started.json as { value: { id: string } }).value.id
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const polled = await r.call({ path: '/flow', query: { id } })
    const state = (polled.json as { value: { state: { status: string; error?: { code: string } } } }).value.state
    if (state.status !== 'running') {
      assert.equal(state.status, 'failed')
      assert.equal(state.error?.code, 'remote/path-unreadable')
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('流程没有落终态')
})

test('/flow 缺 id 或查不存在的 id 都给结构化错误，而不是 500 空白', async () => {
  const missing = await rig().call({ path: '/flow' })
  assert.equal(missing.status, 200)
  assert.equal((missing.json as { code: string }).code, 'remote/unknown')
  assert.match((missing.json as { detail: string }).detail, /缺少 id/)

  const unknown = await rig().call({ path: '/flow', query: { id: 'flow-999' } })
  assert.match((unknown.json as { detail: string }).detail, /没有流程/)
})

test('/flow/cancel 把 running 流程收成 cancelled', async () => {
  const r = rig({ probeFacts: async () => { await new Promise((resolve) => setTimeout(resolve, 50)); return FACTS } })
  const started = await r.call({
    path: '/workspace',
    method: 'POST',
    body: JSON.stringify({ source: 'wsl', distro: 'ubuntu_dev', path: '/home/hui' }),
  })
  const id = (started.json as { value: { id: string } }).value.id
  const cancelled = await r.call({ path: '/flow/cancel', method: 'POST', body: JSON.stringify({ id }) })
  assert.equal((cancelled.json as { value: { state: { status: string } } }).value.state.status, 'cancelled')
})

test('/workspaces 只列已成功的成果', async () => {
  const r = rig()
  await r.call({ path: '/workspace', method: 'POST', body: JSON.stringify({ source: 'local', path: 'D:\\work' }) })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const listed = await r.call({ path: '/workspaces' })
  const records = (listed.json as { value: { localPath: string }[] }).value
  assert.equal(records.length, 1)
  assert.equal(records[0]?.localPath, 'D:\\work')
})

test('非回环地址一律 403，且根本不进业务（越权面必须在最前面拦）', async () => {
  let touched = 0
  const r = rig({
    listSources: async () => {
      touched += 1
      return { wslAvailable: true, distros: DISTROS, probeError: null, ssh: NO_SSH }
    },
  })
  const denied = await r.call({ path: '/sources', address: '192.168.1.10' })
  assert.equal(denied.status, 403)
  assert.equal(touched, 0, '被拒的请求不该触发任何探测')
  assert.equal((denied.json as { ok: boolean }).ok, false)
})

test('method 不匹配回 405 + allow 头', async () => {
  const wrong = await rig().call({ path: '/sources', method: 'POST', body: '{}' })
  assert.equal(wrong.status, 405)
  assert.equal(wrong.headers['allow'], 'GET')
})

test('parseAddInput：非对象、未知来源都抛结构化错误；空串字段被省略', () => {
  assert.throws(() => parseAddInput(undefined), /必须是对象/)
  assert.throws(() => parseAddInput([]), /必须是对象/)
  assert.throws(() => parseAddInput({ source: 'ftp' }), /未知的工作区来源/)
  assert.deepEqual(parseAddInput({ source: 'wsl', distro: '', path: '/x' }), { source: 'wsl', path: '/x' })
})

/** 一个能接上、能断、能重连的投影服务（假 connect，不碰真机）。 */
function projectionRig(): ProjectionService {
  return new ProjectionService({
    store: new ProjectionStore(),
    async connect(): Promise<{ rpc: never; dispose(): void }> {
      return { rpc: fakeProjectionRpc(), dispose() {} }
    },
  })
}

function fakeProjectionRpc(): never {
  return {
    async call(endpoint: string) {
      if (endpoint === 'workspace/create') {
        return { workspace: { workspaceId: 'ws-1', path: '/w', title: 'w', sessionIds: [], createdAt: '', updatedAt: '' }, created: true }
      }
      if (endpoint === 'session/list') return { items: [] }
      throw new Error('假的 RPC 没有准备 ' + endpoint)
    },
    openStream() {
      return { cancel() {}, async *[Symbol.asyncIterator]() {} }
    },
  } as never
}

const PROJECTION_TARGET: ConnectTarget = { backend: 'wsl', distro: 'ubuntu_dev', port: 8899, remoteRoot: '/home/dev/harness' }

test('/disconnect 回整份快照：条目留着标 offline，相位不再是 connected', async () => {
  const projection = projectionRig()
  const r = rig({}, { projection })
  await r.call({ path: '/attach', method: 'POST', body: JSON.stringify({ target: PROJECTION_TARGET, remotePath: '/w' }) })

  const before = (await r.call({ path: '/projection' })).json as { value: { connected: boolean; link: string } }
  assert.equal(before.value.connected, true)
  assert.equal(before.value.link, 'connected')

  const after = (await r.call({ path: '/disconnect', method: 'POST', body: '{}' }))
  assert.equal(after.status, 200)
  const value = (after.json as { value: { connected: boolean; link: string; workspaces: { availability: string }[] } }).value
  assert.equal(value.connected, false)
  assert.equal(value.link, 'idle', '手动断开后没有驱动在跑')
  assert.equal(value.workspaces.length, 1, '断连不删条目，只标离线')
  assert.equal(value.workspaces[0]?.availability, 'offline')
})

test('/reconnect 成功后回 connected 快照；失败如实回错，不假装成功', async () => {
  const projection = projectionRig()
  const r = rig({}, { projection })
  await r.call({ path: '/attach', method: 'POST', body: JSON.stringify({ target: PROJECTION_TARGET, remotePath: '/w' }) })
  await r.call({ path: '/disconnect', method: 'POST', body: '{}' })

  const ok = await r.call({ path: '/reconnect', method: 'POST', body: '{}' })
  assert.equal(ok.status, 200)
  const value = (ok.json as { value: { connected: boolean; link: string } }).value
  assert.equal(value.connected, true)
  assert.equal(value.link, 'connected')

  // 从没连过就重连：必须回错误信封（HTTP 仍是 200，与其它路由一致），不能假装成功。
  const untouched = new ProjectionService({
    store: new ProjectionStore(),
    connect: async () => {
      throw new Error('不该被调用')
    },
  })
  const noTarget = await rig({}, { projection: untouched }).call({ path: '/reconnect', method: 'POST', body: '{}' })
  assert.equal(noTarget.status, 200)
  assert.equal((noTarget.json as { ok: boolean }).ok, false, '没连过就重连必须回错误，而不是空成功')
  assert.ok((noTarget.json as { detail: string }).detail.includes('还没有连过任何远端'))
})

test('/projection/refresh 未接线：明确报错，不回一份假快照', async () => {
  // 与 /plugin-sync 未接线同一条纪律：没接线就说没接线，不能回一份「刚刷新过、什么都没有」
  // 的快照 —— 那会把「功能没上」伪装成「远端很干净」。
  const result = await rig().call({ path: '/projection/refresh', method: 'POST', body: '{}' })
  assert.equal(result.status, 200, '与其它路由一致：错误也走 200 + 错误信封')
  const envelope = result.json as { ok: boolean; code?: string; detail?: string; nextActions?: string[] }
  assert.equal(envelope.ok, false)
  assert.equal(envelope.code, 'remote/unknown')
  assert.ok((envelope.detail ?? '').includes('投影服务没有接线'), envelope.detail)
  assert.ok((envelope.nextActions ?? []).length > 0, '必须给出可执行的下一步')
})

test('/projection/refresh 已接线：200 且快照带 stale=false（刷新成功即不是旧帧）', async () => {
  const projection = projectionRig()
  const r = rig({}, { projection })
  await r.call({ path: '/attach', method: 'POST', body: JSON.stringify({ target: PROJECTION_TARGET, remotePath: '/w' }) })

  const refreshed = await r.call({ path: '/projection/refresh', method: 'POST', body: '{}' })
  assert.equal(refreshed.status, 200)
  const envelope = refreshed.json as {
    ok: boolean
    value?: { stale: boolean; connected: boolean; sessions: unknown[] }
  }
  assert.equal(envelope.ok, true)
  assert.equal(envelope.value?.stale, false, '刷新成功必须回 stale=false')
  assert.equal(envelope.value?.connected, true)
  assert.deepEqual(envelope.value?.sessions, [], '远端说没有会话，刷新不该编出条目')

  // /projection 的行为不变，只是多带一个 stale：读面板仍然不打远端。
  const plain = await r.call({ path: '/projection' })
  assert.equal(plain.status, 200)
  assert.equal((plain.json as { value: { stale: boolean } }).value.stale, false, '/projection 也带 stale')
})

test('NEGATIVE_CONTROL 可假性：把回环守卫去掉必须让 403 断言失败', async () => {
  const negate = process.env.NEGATIVE_CONTROL === '1'
  const denied = await rig().call({ path: '/sources', address: negate ? '127.0.0.1' : '192.168.1.10' })
  assert.equal(denied.status, 403)
})
test('parseAttachInput：WSL 省略 localPath 仍推 UNC；SSH 省略则结构化报错，不猜本地路径', () => {
  const wsl = parseAttachInput({ target: PROJECTION_TARGET, remotePath: '/home/dev/proj' })
  assert.equal(wsl.localPath, '\\\\wsl.localhost\\ubuntu_dev\\home\\dev\\proj')

  const sshTarget = { backend: 'ssh' as const, alias: 'gcp', port: 8899, remoteRoot: '/home/dev/harness' }
  assert.throws(
    () => parseAttachInput({ target: sshTarget, remotePath: '/home/dev/proj' }),
    (error: unknown) => {
      assert.ok(error instanceof RemoteCrError)
      assert.equal(error.code, 'remote/workspace-unwritable')
      assert.ok(error.detail.includes('gcp'), error.detail)
      return true
    },
  )

  // 显式给了就放行：锚点目录由调用方落实（S9.5b-2 接线）
  const explicit = parseAttachInput({
    target: sshTarget,
    remotePath: '/home/dev/proj',
    localPath: 'D:\\anchors\\gcp\\home\\dev\\proj',
  })
  assert.equal(explicit.localPath, 'D:\\anchors\\gcp\\home\\dev\\proj')
})
test('注入锚点落实器后，SSH 目标省略 localPath 也能接入（且落实器拿到的是别名目标）', async () => {
  const seen: string[] = []
  const projection = new ProjectionService({
    store: new ProjectionStore(),
    connect: async () => { throw new Error('这条测试不该真的连远端') },
  })
  // 用假的 attach 结果顶替真远端：这里验的是「路由把落实后的 localPath 交给了服务」
  const captured: { localPath?: string } = {}
  const original = projection.attach.bind(projection)
  let seenTarget: SshConnectTarget | undefined
  projection.attach = async (target, request) => {
    seenTarget = target as SshConnectTarget
    captured.localPath = request.localPath
    throw Object.assign(new Error('stub'), { name: 'StubAttach' })
  }
  const sshTarget = { backend: 'ssh' as const, alias: 'gcp', port: 8899, remoteRoot: '/home/dev/harness' }
  const answer = await rig({}, {
    projection,
    resolveAnchorPath: async (target, remotePath) => {
      seen.push(target.alias + ' ' + remotePath)
      return 'D:/anchors/gcp' + remotePath
    },
  }).call({ path: '/attach', method: 'POST', body: JSON.stringify({ target: sshTarget, remotePath: '/home/dev/proj' }) })

  assert.deepEqual(seen, ['gcp /home/dev/proj'], '落实器必须拿到别名与远端路径')
  assert.equal(seenTarget?.backend, 'ssh', '服务拿到的必须是 SSH 目标')
  assert.equal(captured.localPath, 'D:/anchors/gcp/home/dev/proj', '交给服务的是落实后的本地路径')
  assert.equal(answer.status, 200)
  assert.equal((answer.json as { ok: boolean }).ok, false, '假 attach 抛错要如实回错误包')
  projection.attach = original
})
test('defaultAnchorResolver：别名不在 config 里带码报出，绝不猜一个本地路径', async () => {
  const home = await mkdtemp(join(tmpdir(), 'remote-cr-anchor-'))
  const resolver = defaultAnchorResolver(home)
  await assert.rejects(
    () => resolver({ backend: 'ssh', alias: 'nope', port: 8899, remoteRoot: '/home/dev/h' }, '/home/dev/proj'),
    (error: unknown) => {
      const remoteCr = error as RemoteCrError
      assert.equal(remoteCr.code, 'remote/ssh-target-unresolved')
      assert.ok(remoteCr.detail.includes('nope'), remoteCr.detail)
      return true
    },
  )
})

test('defaultAnchorResolver：别名在 config 里就建出锚点目录并返回它（本地路径真的存在）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'remote-cr-anchor-'))
  const sshDir = join(home, '.ssh')
  await mkdir(sshDir, { recursive: true })
  await writeFile(join(sshDir, 'config'), 'Host gcp\n  HostName 10.0.0.9\n  User hui\n', 'utf8')

  const resolver = defaultAnchorResolver(home)
  const localPath = await resolver(
    { backend: 'ssh', alias: 'gcp', port: 8899, remoteRoot: '/home/dev/h' },
    '/home/dev/proj',
  )
  assert.ok(localPath.replaceAll('\\', '/').endsWith('/home/dev/proj'), localPath)
  assert.equal((await stat(localPath)).isDirectory(), true, '锚点目录必须真建出来，否则 workspaceRegistry.create 会拒')

  // map.json 与目录同落：虚拟路径 ≡ 远端绝对路径（默认 / → /）
  const anchorDir = localPath.replaceAll('\\', '/').slice(0, localPath.replaceAll('\\', '/').indexOf('/home/dev/proj'))
  const mapPath = join(anchorDir, 'map.json')
  const map = JSON.parse(await readFile(mapPath, 'utf8')) as { version: number; target: { host: string } }
  assert.equal(map.version, 1)
  assert.equal(map.target.host, '10.0.0.9')
})
test('/anchors 打印本机锚点映射；没有锚点时是空清单而不是错误', async () => {
  const emptyHome = await mkdtemp(join(tmpdir(), 'remote-cr-routes-home-'))
  const empty = await rig({}, { homeDir: emptyHome }).call({ path: '/anchors' })
  assert.equal(empty.status, 200)
  const emptyValue = (empty.json as { value: { directory: string; anchors: unknown[] } }).value
  assert.deepEqual(emptyValue.anchors, [])
  assert.ok(emptyValue.directory.endsWith('anchors'), emptyValue.directory)

  // 用产品自己的 ensureAnchorDir 造一份真锚点，再让路由读出来：两边必须指向同一份 map.json
  const homeDir = await mkdtemp(join(tmpdir(), 'remote-cr-routes-home-'))
  const anchorTarget: SshTarget = {
    alias: 'gcp',
    hostName: '10.0.0.9',
    user: 'hui',
    port: 22,
    identityFiles: [],
    proxyJump: [],
    source: { file: '<test>', line: 1 },
  }
  const resolved = await resolveAnchorPath({ homeDir, target: anchorTarget, remotePath: '/home/hui/proj' })
  const found = await rig({}, { homeDir }).call({ path: '/anchors' })
  const value = (found.json as { value: { anchors: { id: string; ok: boolean; lines: string[] }[] } }).value
  assert.equal(value.anchors.length, 1)
  const entry = value.anchors[0]
  assert.ok(entry !== undefined)
  assert.equal(entry.id, resolved.map.id)
  assert.equal(entry.ok, true)
  assert.ok(entry.lines.some((line) => line.includes('映射：')), entry.lines.join(' | '))
})

/** 一条真实的磁盘丢失诊断（真机 2026-11-14 的 E_INVALIDARG 现场，细节见 diagnosis.test.ts）。 */
const DISK_MISSING: WslDiagnosis = {
  code: 'wsl/disk-missing',
  detail: '发行版 ubuntu_dev 的虚拟磁盘挂载失败：WSL 找不到或打不开它的 ext4.vhdx（WSL 自报 Wsl/Service/CreateInstance/MountDisk/HCS/E_INVALIDARG）',
  nextActions: ['确认诊断里的 ext4.vhdx 路径真实存在'],
  wslCode: 'Wsl/Service/CreateInstance/MountDisk/HCS/E_INVALIDARG',
  logTail: 'Failed to attach disk ext4.vhdx to WSL2: 系统找不到指定的文件。',
}

test('/wsl/wake 成功：200 + ok:true + ms，诊断恒为 null', async () => {
  const seen: string[] = []
  const answer = await rig({
    wakeDistro: async (distro) => {
      seen.push(distro)
      return { distro, ok: true, ms: 37, diagnosis: null }
    },
  }).call({ path: '/wsl/wake', method: 'POST', body: JSON.stringify({ distro: 'ubuntu_dev' }) })
  assert.equal(answer.status, 200)
  const value = (answer.json as { value: WslWakeResult }).value
  assert.deepEqual(value, { distro: 'ubuntu_dev', ok: true, ms: 37, diagnosis: null })
  assert.deepEqual(seen, ['ubuntu_dev'], '唤醒必须按名字落到那一个发行版上')
})

test('/wsl/wake 失败：仍是 200 + ok:false + 诊断（可预期失败，不是服务器故障）', async () => {
  const answer = await rig({
    wakeDistro: async () => ({ distro: 'ubuntu_dev', ok: false, ms: 41, diagnosis: DISK_MISSING }),
  }).call({ path: '/wsl/wake', method: 'POST', body: JSON.stringify({ distro: 'ubuntu_dev' }) })
  assert.equal(answer.status, 200, '5xx 只会让 UI 把它当网络错误去重试')
  const value = (answer.json as { value: WslWakeResult }).value
  assert.equal(value.ok, false)
  assert.equal(value.diagnosis?.code, 'wsl/disk-missing')
  assert.ok(value.diagnosis?.wslCode?.includes('E_INVALIDARG'), value.diagnosis?.wslCode ?? '')
})

test('/wsl/wake 未知发行版：remote/unknown，且根本不 spawn', async () => {
  let woken = 0
  const answer = await rig({
    wakeDistro: async (distro) => {
      woken += 1
      return { distro, ok: true, ms: 1, diagnosis: null }
    },
  }).call({ path: '/wsl/wake', method: 'POST', body: JSON.stringify({ distro: 'not-a-distro' }) })
  assert.equal(answer.status, 200)
  const payload = answer.json as { ok: boolean; code: string; detail: string }
  assert.equal(payload.ok, false)
  assert.equal(payload.code, 'remote/unknown')
  assert.ok(payload.detail.includes('not-a-distro'), payload.detail)
  assert.equal(woken, 0, '不在清单里的名字不该换来一次 wsl.exe')
})

test('/wsl/wake 缓存命中：60 秒内同一发行版只 spawn 一次', async () => {
  let spawned = 0
  const r = rig({
    wakeDistro: async (distro) => {
      spawned += 1
      return { distro, ok: true, ms: 20 + spawned, diagnosis: null }
    },
  })
  const body = JSON.stringify({ distro: 'ubuntu_dev' })
  const first = await r.call({ path: '/wsl/wake', method: 'POST', body })
  const second = await r.call({ path: '/wsl/wake', method: 'POST', body })
  assert.equal(spawned, 1, '重复点同一发行版不该再 spawn')
  const firstValue = (first.json as { value: WslWakeResult }).value
  const secondValue = (second.json as { value: WslWakeResult }).value
  assert.deepEqual(secondValue, firstValue)
  assert.equal(secondValue.ms, 21)
})

test('/wsl/wake 失败不缓存：修好 vhdx 后点重试必须真的重试', async () => {
  let spawned = 0
  const r = rig({
    wakeDistro: async (distro) => {
      spawned += 1
      return { distro, ok: false, ms: 5, diagnosis: DISK_MISSING }
    },
  })
  const body = JSON.stringify({ distro: 'ubuntu_dev' })
  await r.call({ path: '/wsl/wake', method: 'POST', body })
  await r.call({ path: '/wsl/wake', method: 'POST', body })
  assert.equal(spawned, 2, '失败被缓存 60 秒会把「重试启动」变成装饰')
})
test('/wsl/wake 客户端断开必须真的打断 wsl.exe（取消不是装饰）', async () => {
  let seen: AbortSignal | undefined
  let abortedAtEnd = false
  let last: FakeRes | null = null
  const makeRes = (): FakeRes => {
    const made = fakeClosableRes()
    last = made
    return made
  }
  const { call } = rig(
    {
      wakeDistro: async (distro, signal) => {
        seen = signal
        const deadline = Date.now() + 800
        while (signal?.aborted !== true && Date.now() < deadline) {
          await new Promise((done) => setTimeout(done, 5))
        }
        abortedAtEnd = signal?.aborted === true
        return { distro, ok: false, ms: 5, diagnosis: DISK_MISSING }
      },
    },
    {},
    makeRes,
  )
  const pending = call({ path: '/wsl/wake', method: 'POST', body: JSON.stringify({ distro: 'ubuntu_dev' }) })
  await new Promise((done) => setTimeout(done, 40))
  assert.notEqual(seen, undefined, '唤醒必须真的开跑，否则这条用例什么都没验到')
  ;(last as FakeRes | null)?.close()
  await pending
  assert.equal(abortedAtEnd, true, '客户端断开必须把 abort 送到 wakeDistro（否则 wsl.exe 会跑满超时）')
})

test('/wsl/wake 校验阶段就断开：连 spawn 都不该发生', async () => {
  let spawned = 0
  let last: FakeRes | null = null
  const makeRes = (): FakeRes => {
    const made = fakeClosableRes()
    last = made
    return made
  }
  const { call } = rig(
    {
      listSources: async () => {
        await new Promise((done) => setTimeout(done, 60))
        return { wslAvailable: true, distros: DISTROS, probeError: null, ssh: NO_SSH }
      },
      wakeDistro: async (distro) => {
        spawned += 1
        return { distro, ok: true, ms: 1, diagnosis: null }
      },
    },
    {},
    makeRes,
  )
  const pending = call({ path: '/wsl/wake', method: 'POST', body: JSON.stringify({ distro: 'ubuntu_dev' }) })
  await new Promise((done) => setTimeout(done, 10))
  ;(last as FakeRes | null)?.close()
  const reply = await pending
  assert.equal(spawned, 0, '校验期断开之后不许再 spawn wsl.exe（R1-L1）')
  assert.equal(reply.body, '', '断开之后不许再往已关闭的 res 上写响应')
})
