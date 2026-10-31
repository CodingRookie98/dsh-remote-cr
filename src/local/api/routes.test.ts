import assert from 'node:assert/strict'
import test from 'node:test'

import type { DirListing, DistroInfo, RemoteFacts, SourceReport } from '../../shared/api.ts'
import { API_PREFIX } from '../../shared/api.ts'
import type { HostDeps, MountedRoute, TeleportHostContext } from './routes.ts'
import { parseAddInput, registerTeleportRoutes } from './routes.ts'

const DISTROS: DistroInfo[] = [
  { name: 'ubuntu_dev', state: 'Running', version: 2, isDefault: true },
]

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

function fakeRes(): { res: never; read(): Call } {
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

function rig(overrides: Partial<HostDeps> = {}): Rig {
  const calls: string[] = []
  const deps: HostDeps = {
    listSources: async (): Promise<SourceReport> => ({ wslAvailable: true, distros: DISTROS, probeError: null }),
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
    ...overrides,
  }

  const routes = new Map<string, (req: never, res: never) => Promise<void> | void>()
  const effects: string[] = []
  const ctx: TeleportHostContext = {
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

  const mounted = registerTeleportRoutes(ctx, { deps, wslExecutable: 'wsl.exe' })
  assert.deepEqual(effects.length, mounted.length, '每条路由恰好一个 effect')

  return {
    deps,
    mounted,
    async call(input) {
      const url = new URL(API_PREFIX + input.path, 'http://teleport.invalid')
      for (const [key, value] of Object.entries(input.query ?? {})) url.searchParams.set(key, value)
      const handler = routes.get(url.pathname)
      assert.notEqual(handler, undefined, '没有挂载 ' + url.pathname)
      const { res, read } = fakeRes()
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

test('六条路由全部挂载在 /teleport/api 下，且各自声明允许的 method', () => {
  const { mounted } = rig()
  assert.deepEqual(
    mounted.map((route) => route.path + ' ' + route.allowed.join('|')).sort(),
    [
      '/teleport/api/flow GET',
      '/teleport/api/flow/cancel POST',
      '/teleport/api/list GET',
      '/teleport/api/sources GET',
      '/teleport/api/workspace POST',
      '/teleport/api/workspaces GET',
    ],
  )
})

test('/sources 回四选一 + 可点清单；探测失败也回 200（灰显不是错误）', async () => {
  const ok = await rig().call({ path: '/sources' })
  assert.equal(ok.status, 200)
  const value = (ok.json as { value: { options: unknown[]; selectable: string[] } }).value
  assert.equal(value.options.length, 4)
  assert.deepEqual(value.selectable, ['local', 'wsl'])

  const degraded = await rig({
    listSources: async () => ({ wslAvailable: false, distros: [], probeError: 'wsl.exe 不存在' }),
  }).call({ path: '/sources' })
  assert.equal(degraded.status, 200, '没装 WSL 是正常情况，不能回 5xx')
  const degradedValue = (degraded.json as { value: { selectable: string[]; probeError: string } }).value
  assert.deepEqual(degradedValue.selectable, ['local'])
  assert.equal(degradedValue.probeError, 'wsl.exe 不存在')
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
      return { wslAvailable: true, distros: DISTROS, probeError: null }
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

test('NEGATIVE_CONTROL 可假性：把回环守卫去掉必须让 403 断言失败', async () => {
  const negate = process.env.NEGATIVE_CONTROL === '1'
  const denied = await rig().call({ path: '/sources', address: negate ? '127.0.0.1' : '192.168.1.10' })
  assert.equal(denied.status, 403)
})
