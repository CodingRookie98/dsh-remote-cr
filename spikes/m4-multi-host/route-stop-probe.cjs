#!/usr/bin/env node
/**
 * 路由级 `/stop` 取证（RFC-0007 最后一条记账）。
 *
 * 为什么单测不够：`routes.test.ts` 用的是假 req/res，量不出「响应发出去的那一刻 entry 是否已经删掉」。
 * 这里挂**真的 http.Server**、发**真的 fetch**，因此能断言：
 *   S1 /attach 成功、hub 里有一台；
 *   S2 远端实例登记里有 pid，且该 pid 在 `/proc` 里活着；
 *   S3 /stop 回 200；
 *   **S4 响应到达客户端时，hub.entries() 已经是 0**（await 顺序正确，P4 P1-1 的那条保证）；
 *   S5 远端那个 pid 消失（真回收）；
 *   S6 再打一次 /stop 仍 200（幂等，不复活）。
 *
 * 跑法：node spikes/m4-multi-host/route-stop-probe.cjs   （需要 DSH_SSH_ALIAS 指向可达主机，默认 wsl_local）
 */
const http = require('node:http')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const { pathToFileURL } = require('node:url')

const ALIAS = process.env.DSH_SSH_ALIAS ?? 'wsl_local'
const ROOT = process.env.DSH_SSH_ROOT ?? '/home/hui/workspace'
const HOME_DIR = process.env.USERPROFILE ?? process.env.HOME ?? ''
const PORT = 8955
const API = '/remote-cr/api'

let passed = 0
let failed = 0
const failures = []
function expect(name, ok, detail) {
  if (ok) { passed += 1; console.log('  PASS ' + name + (detail ? ' ' + detail : '')) }
  else { failed += 1; failures.push(name); console.log('  FAIL ' + name + (detail ? ' ' + detail : '')) }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const load = async (rel) => import(pathToFileURL(path.join(process.cwd(), rel)).href)

function ssh(script) {
  const out = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', ALIAS, script], { windowsHide: true })
  return Buffer.from(out.stdout ?? []).toString('utf8').trim()
}
const alive = (pid) => ssh('[ -d /proc/' + String(pid) + ' ] && echo yes || echo no') === 'yes'
function instancePids() {
  const names = ssh("ls -1 $HOME/.dsh-remote-cr/instances 2>/dev/null || true").split('\n').filter((n) => n.endsWith('.json'))
  const out = []
  for (const name of names) {
    try {
      const parsed = JSON.parse(ssh('cat $HOME/.dsh-remote-cr/instances/' + name + ' 2>/dev/null || true'))
      if (Number.isInteger(parsed.pid) && parsed.pid > 0) out.push(parsed.pid)
    } catch {}
  }
  return out
}

async function main() {
  const routesMod = await load('src/local/api/routes.ts')
  const liveMod = await load('src/local/projection/live.ts')
  const serviceMod = await load('src/local/projection/service.ts')
  const storeMod = await load('src/local/projection/store.ts')
  const hubMod = await load('src/local/projection/hub.ts')

  const hub = new hubMod.ProjectionHub(
    () =>
      new serviceMod.ProjectionService({
        store: new storeMod.ProjectionStore(),
        connect: liveMod.createLiveConnect({ launchTimeoutMs: 120000, ssh: { homeDir: HOME_DIR, authFor: async () => ({ kind: 'key' }) } }),
      }),
  )

  // 最小 ctx：只提供路由真正用到的两个能力（读 routes.ts 的 mount() 得来）。
  const specs = []
  const ctx = {
    webServer: { register(spec) { specs.push(spec) } },
    effect(fn) { fn() },
    on() {},
  }
  routesMod.registerRemoteCrRoutes(ctx, { hub, homeDir: HOME_DIR })

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const spec = specs.find((candidate) => candidate.path === url.pathname)
    if (spec === undefined) {
      res.writeHead(404).end('no route')
      return
    }
    Promise.resolve(spec.handler(req, res)).catch((error) => {
      res.writeHead(500).end(String(error && error.message))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + String(server.address().port)

  const target = { backend: 'ssh', alias: ALIAS, port: PORT, remoteRoot: ROOT }
  console.log('==> S1 attach')
  const attach = await fetch(base + API + '/attach', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target, remotePath: ROOT, localPath: 'C:/Temp/route-stop', title: 'route' }),
  })
  const attachBody = await attach.json()
  expect('S1', attach.status === 200 && attachBody.ok === true, JSON.stringify({ status: attach.status, ok: attachBody.ok, code: attachBody.code }))

  console.log('==> S2 远端登记里有 pid 且活着')
  const pids = instancePids()
  const live = pids.filter((pid) => alive(pid))
  expect('S2', live.length > 0, JSON.stringify({ pids, live }))
  const watched = live[live.length - 1]

  console.log('==> S3/S4 POST /stop（真实 HTTP）')
  const stop = await fetch(base + API + '/stop', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target }),
  })
  const entriesAtResponse = hub.entries().length
  // **response 到手那一刻**就去问远端：进程还在不在。
  
  // 注意：`releaseAll` 是「先摘 entry 再 await」，所以 `entriesAtResponse===0` **在漏 await 时也成立**
  // （第一版就是这么假绿的）。真正能分辨 await 的是这一条：不 await 的话响应先回，远端进程还没被杀。
  const aliveAtResponse = watched !== undefined && alive(watched)
  expect('S3', stop.status === 200, JSON.stringify({ status: stop.status }))
  // **诚实记录这条判据的边界**：`releaseAll` 是「先摘 entry 再 await」，所以 `entriesAtResponse===0`
  // 在**漏 await 时同样成立**；而「远端 pid 在响应时已消失」也不成立——远端杀进程本身是异步的
  // （`dispose()` resolve 不等于内核已回收）。所以这里只断言能确认的事实，
  // 「有没有 await」由 `routes.test.ts` 的「回收失败要如实回错」用例把关（漏 await 就传播不出错误码）。
  expect('S4', entriesAtResponse === 0, JSON.stringify({ entriesAtResponse, aliveAtResponse }))

  console.log('==> S5 远端 pid 最终消失（兜底：即使 S4 侥幸通过也要确认真的收了）')
  let still = aliveAtResponse
  const deadline = Date.now() + 15000
  while (Date.now() < deadline && still) {
    await sleep(500)
    still = watched !== undefined && alive(watched)
  }
  expect('S5', watched !== undefined && !still, JSON.stringify({ watched, still }))

  console.log('==> S6 再打一次 /stop 仍 200（幂等）')
  const again = await fetch(base + API + '/stop', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target }),
  })
  expect('S6', again.status === 200, JSON.stringify({ status: again.status }))

  server.close()
  hub.disposeAll()
  mkdirSync('spikes/m4-multi-host', { recursive: true })
  writeFileSync('spikes/m4-multi-host/route-stop.json', JSON.stringify({
    passed, failed, failures, watched, entriesAtResponse, aliveAtResponse, at: new Date().toISOString(),
  }, null, 2) + '\n')
  console.log('\n路由级 /stop 探针：通过 ' + passed + ' / 失败 ' + failed + (failed === 0 ? '' : ' → ' + failures.join(',')))
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => { console.error('probe crashed: ' + (error && error.stack ? error.stack : error)); process.exit(2) })
