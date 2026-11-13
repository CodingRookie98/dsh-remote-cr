/**
 * M2 出口门槛 1 的**模型请求**版证据：远端 agent 调模型时，请求真的落到本机凭据代理。
 *
 * 与 `proxy-ingress.ts` 的分工：那一份证明「隧道通、能换值」（用远端 curl 打的）；
 * 这一份证明「**远端 dsh 自己在调模型**时走的就是这条隧道」—— 也就是把 provider 的
 * baseURL 与 key 通过 `extraEnv` 指到 `-R` 分配的端口上，再让远端真的跑一次 `session/prompt`。
 *
 * 为什么需要产品侧的 `extraEnv`：`-R 127.0.0.1:0:` 的端口要等连接建好才知道，
 * 而 provider 只能通过环境变量（`DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY`）在启动时告诉远端。
 * 脚本里写 `$TELEPORT_PROXY_URL`，由远端脚本在 read 到端口之后展开。
 *
 * 断言只认**代理侧日志**（`proxy.records()`）与**假上游收到的东西**，不认远端自述：
 * 「远端说它配好了」不算证据，字节到了本机才算。
 *
 * 跑法：`MSYS_NO_PATHCONV=1 node spikes/m2/ssh-e2e/model-request.ts [alias] [remoteRoot]`
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { readSshConfig, resolveSshTarget } from '../../../src/local/backend/ssh/config.ts'
import { createLiveConnect } from '../../../src/local/projection/live.ts'
import type { ConnectTarget, RemoteConnection } from '../../../src/local/projection/service.ts'
import { LocalCredentials } from '../../../src/local/proxy/credentials.ts'
import { startCredentialProxy } from '../../../src/local/proxy/runtime.ts'
import { RemoteRpc } from '../../../src/local/projection/remote.ts'

const ALIAS = process.argv[2] ?? 'gcp'
const RAW_ROOT = process.argv[3] ?? 'home/hui/workspace'
const REMOTE_ROOT = RAW_ROOT.startsWith('/') ? RAW_ROOT : '/' + RAW_ROOT
const HOME_DIR = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
const REMOTE_PORT = Number(process.env['REMOTE_PORT'] ?? '8953')
const DSH_HOME = process.env['REMOTE_DSH_HOME'] ?? '/tmp/teleport-gate1/dshhome'
const REF = 'DEEPSEEK_API_KEY'
const REAL_VALUE = 'sk-real-gate1-model'

interface Measurement { readonly name: string; readonly ok: boolean; readonly detail: string }
const results: Measurement[] = []
function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail })
  console.log((ok ? '  ok   ' : '  FAIL ') + name + ' — ' + detail)
}

interface Seen { readonly path: string; readonly authorization: string | undefined; readonly body: string }
/** 假上游：不追求把 Anthropic 流答对，只求把「谁在什么时候带着什么 key 打了过来」留下来。 */
async function startFakeUpstream(): Promise<{ base: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      seen.push({
        path: req.url ?? '/',
        // DeepSeek 适配器用 `x-api-key`；Anthropic 风格用 `authorization`。两个都记，断言认哪一个由代理换过的那条决定。
        authorization: [req.headers['authorization'], req.headers['x-api-key']]
          .filter((value): value is string => typeof value === 'string')
          .join(' | '),
        body: Buffer.concat(chunks).toString('utf8'),
      })
      if ((req.url ?? '').includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [] }))
        return
      }
      // 故意给一个**不完整**的 Messages 流：证据是请求到达，不是这一轮对话成功。
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('event: error\ndata: {"type":"error","error":{"type":"fake","message":"fake upstream"}}\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const base = 'http://127.0.0.1:' + String((server.address() as AddressInfo).port)
  return { base, seen, close: () => new Promise<void>((resolve) => { server.close(() => resolve()) }) }
}

const configFile = join(HOME_DIR, '.ssh', 'config')
const config = readSshConfig({ file: configFile, homeDir: HOME_DIR })
const resolved = resolveSshTarget(config.parsed, ALIAS, { homeDir: HOME_DIR, file: configFile })
if (resolved.target === undefined) {
  console.error('没有别名 ' + ALIAS + '：' + resolved.problems.map((item) => item.message).join(' / '))
  process.exit(2)
}

const upstream = await startFakeUpstream()
const credentials = new LocalCredentials({ env: {}, refs: new Map([[REF, REAL_VALUE]]) })
const proxy = await startCredentialProxy({
  credentials,
  resolveUpstream: (provider) => (provider === 'deepseek' ? upstream.base : undefined),
})
const placeholder = proxy.env[REF] ?? ''
record('MR-1 代理起来了且拿到了占位串', proxy.port > 0 && placeholder !== '', 'port=' + String(proxy.port))

const connect = createLiveConnect({ ssh: {
  homeDir: HOME_DIR,
  authFor: async () => ({ kind: 'key' as const }),
  proxyPort: proxy.port,
  extraEnv: {
    DSH_HOME,
    DEEPSEEK_BASE_URL: '$TELEPORT_PROXY_URL/r/deepseek',
    DEEPSEEK_API_KEY: placeholder,
  },
} })
const target: ConnectTarget = {
  backend: 'ssh',
  alias: ALIAS,
  port: REMOTE_PORT,
  remoteRoot: REMOTE_ROOT,
}
let connection: RemoteConnection | undefined
try {
  connection = await connect(target)
} catch (error) {
  record('MR-2 远端起来了（含 -R）', false, error instanceof Error ? error.message : String(error))
  await proxy.stop()
  await upstream.close()
  const bad = results.filter((item) => !item.ok)
  console.log('')
  console.log(String(results.length - bad.length) + '/' + String(results.length) + ' passed')
  process.exit(1)
}
const remoteProxyPort = connection.remoteProxyPort
record('MR-2 -R 拿到了远端口，且 extraEnv 里引用的就是它', remoteProxyPort !== undefined && remoteProxyPort > 0, 'remoteProxyPort=' + String(remoteProxyPort))
const rpc = connection.rpc
let sessionId: string | undefined
try {
  const created = await rpc.call<{ sessionId?: string }>('session/create', { args: { request: { cwd: REMOTE_ROOT } } })
  sessionId = typeof created?.sessionId === 'string' ? created.sessionId : undefined
  record('MR-3 远端建出了会话', sessionId !== undefined, 'sessionId=' + String(sessionId))
} catch (error) {
  record('MR-3 远端建出了会话', false, error instanceof Error ? error.message : String(error))
}

if (sessionId !== undefined) {
  let catalog: unknown
  try {
    catalog = await rpc.call<unknown>('session/modelCatalog', { args: {} })
  } catch (error) {
    catalog = undefined
    console.log('  info  modelCatalog 失败：' + (error instanceof Error ? error.message : String(error)))
  }
  const groups = (catalog as { groups?: Array<{ id: string; models: Array<{ id: string }> }> } | undefined)?.groups ?? []
  const first = groups.flatMap((group) => group.models.map((model) => ({ provider: group.id, model: model.id })))[0]
  record('MR-4 远端报出了可路由模型', first !== undefined, JSON.stringify(groups.map((group) => group.id)))
  if (first !== undefined) {
    try {
      await rpc.call<unknown>('session/selectModel', { args: { request: { sessionId, selection: first } } })
    } catch (error) {
      console.log('  info  selectModel 失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }
  try {
    await rpc.call<unknown>('session/prompt', {
      args: {
        request: {
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: 'say hi' }],
        },
      },
    })
    record('MR-5 远端接受了 prompt', true, 'sessionId=' + sessionId)
  } catch (error) {
    record('MR-5 远端接受了 prompt', false, error instanceof Error ? error.message : String(error))
  }
}

const deadline = Date.now() + 90_000
let hit = undefined as (typeof import('../../../src/local/proxy/proxy.ts'))['ProxyRecord'] | undefined
while (Date.now() < deadline) {
  hit = proxy.proxy.records().find((item) => item.path.startsWith('/r/deepseek'))
  if (hit !== undefined) break
  await new Promise((resolve) => setTimeout(resolve, 500))
}
const seenByUpstream = upstream.seen.find((item) => item.path.includes('messages'))
record('MR-6 代理侧收到了远端发来的模型请求', hit !== undefined, hit === undefined ? '90s 内没有 /r/deepseek 记录' : hit.path + ' status=' + String(hit.status) + ' outcome=' + hit.outcome)
record('MR-7 代理把占位串换成了真值（substitutions 非空）', (hit?.substitutions.length ?? 0) > 0, JSON.stringify(hit?.substitutions ?? []))
record(
  'MR-8 假上游收到的是真值、不是占位串',
  seenByUpstream !== undefined && seenByUpstream.authorization.includes(REAL_VALUE) && !seenByUpstream.authorization.includes(placeholder),
  String(seenByUpstream?.authorization),
)

connection.dispose()
await proxy.stop()
await upstream.close()

const failed = results.filter((item) => !item.ok)
console.log('')
console.log(String(results.length - failed.length) + '/' + String(results.length) + ' passed')
process.exit(failed.length === 0 ? 0 : 1)