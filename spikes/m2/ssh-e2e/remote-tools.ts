/**
 * M2 出口 A3：远端**真的装上并激活**的插件，在远端会话里注册了工具。
 *
 * 为什么不能只看文件：插件装进 `~/.dsh/profiles/web` 只是一份 package.json + node_modules，
 * 「已装」与「已注册进 agent 的工具表」之间隔着 bundle 激活、插件加载、tools.register 三道门。
 * 唯一不可辩驳的证据是远端 agent 发给模型的请求体里那份 `tools[]` —— 它就是运行时真实工具表。
 *
 * 本探针不装任何东西：期望由环境变量给定，装/卸由调用者在两次运行之间完成。
 *   EXPECT=present（默认）：tools 里必须有 EXPECT_TOOL
 *   EXPECT=absent：tools 里必须没有 EXPECT_TOOL
 * 两次都绿才算「工具确实来自那个插件」，单次绿只能说明表里有/没有这个名字。
 *
 * 跑法：`MSYS_NO_PATHCONV=1 EXPECT=present EXPECT_TOOL=web_search node spikes/m2/ssh-e2e/remote-tools.ts gcp home/hui/workspace`
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'

import { LocalCredentials } from '../../../src/local/proxy/credentials.ts'
import { startCredentialProxy } from '../../../src/local/proxy/runtime.ts'
import { createLiveConnect } from '../../../src/local/projection/live.ts'
import { ProjectionService } from '../../../src/local/projection/service.ts'
import { ProjectionStore } from '../../../src/local/projection/store.ts'
import { resolveAnchorPath } from '../../../src/local/backend/ssh/anchor-runtime.ts'
import { readSshConfig, resolveSshTarget } from '../../../src/local/backend/ssh/config.ts'
import type { ConnectTarget, RemoteConnection } from '../../../src/local/projection/service.ts'

const NL = String.fromCharCode(10)
const ALIAS = process.argv[2] ?? 'gcp'
const RAW_ROOT = process.argv[3] ?? 'home/hui/workspace'
const REMOTE_ROOT = RAW_ROOT.startsWith('/') ? RAW_ROOT : '/' + RAW_ROOT
const HOME_DIR = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
const REMOTE_PORT = Number(process.env['REMOTE_PORT'] ?? '8969')
const DSH_HOME = process.env['REMOTE_DSH_HOME'] ?? '/tmp/teleport-a3/dshhome'
const REF = 'DEEPSEEK_API_KEY'
const REAL_VALUE = 'sk-real-a3-tools'
const EXPECT_TOOL = process.env['EXPECT_TOOL'] ?? 'web_search'
const NEGATIVE = process.env['NEGATIVE_CONTROL'] === '1'
// 负控只把**期望方向**反过来：装了却说没有、没装却说有。其余断言不动，
// 于是「失败集恰好只有 A3-3」同时证明了 A3-3 有内容、且没串到别的断言上。
const EXPECT_RAW = (process.env['EXPECT'] ?? 'present').toLowerCase()
const EXPECT = (NEGATIVE ? (EXPECT_RAW === 'present' ? 'absent' : 'present') : EXPECT_RAW)

interface Measurement { readonly name: string; readonly ok: boolean; readonly detail: string }
const results: Measurement[] = []
function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail })
  console.log((ok ? '  ok   ' : '  FAIL ') + name + ' — ' + detail)
}

interface Seen { readonly path: string; readonly body: string }
function toolNames(body: string): string[] {
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return [] }
  const tools = (parsed as { tools?: unknown }).tools
  if (!Array.isArray(tools)) return []
  return tools.map((item) => String((item as { name?: unknown }).name ?? ''))
}

function sse(res: import('node:http').ServerResponse, events: unknown[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const event of events) {
    res.write('event: ' + String((event as { type: string }).type) + NL + 'data: ' + JSON.stringify(event) + NL + NL)
  }
  res.end()
}

function textEvents(text: string): unknown[] {
  return [
    { type: 'message_start', message: { id: 'msg-a3', role: 'assistant', usage: { input_tokens: 7, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ]
}

async function startFakeModel(): Promise<{ base: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      seen.push({ path: req.url ?? '/', body })
      if (!(req.url ?? '').includes('messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [] }))
        return
      }
      // 只要一次文本轮就够：我们要的是**请求体**，不是会话跑完。
      sse(res, textEvents('a3 verification done'))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const base = 'http://127.0.0.1:' + String((server.address() as AddressInfo).port)
  return { base, seen, close: () => new Promise<void>((resolve) => { server.close(() => resolve()) }) }
}

async function sshRun(command: string, timeoutMs = 30_000): Promise<{ code: number; stdout: string }> {
  return await new Promise((resolve) => {
    const child = spawn('ssh', ['-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', ALIAS, command], { windowsHide: true })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    const timer = setTimeout(() => { child.kill() }, timeoutMs)
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout }) })
  })
}

const remoteHostname = (await sshRun('hostname')).stdout.trim()
record('A3-0 ssh 通道可用', remoteHostname !== '', remoteHostname)
// 独立看一眼 profile 里的「已装」状态：它只是一份文件事实，故意与 A3-3 分开断言，
// 这样「装了但没注册」会被 A3-3 单独抓到，而不是被 A3-0 混过去。
const manifest = (await sshRun('cat ~/.dsh/profiles/web/package.json 2>/dev/null')).stdout
const deps = (() => { try { return Object.keys((JSON.parse(manifest) as { dependencies?: Record<string, string> }).dependencies ?? {}) } catch { return [] } })()
record('A3-0b 远端 profile 的已装依赖（文件事实，不是注册证据）', true, JSON.stringify(deps))

const model = await startFakeModel()
const credentials = new LocalCredentials({ env: {}, refs: new Map([[REF, REAL_VALUE]]) })
const proxy = await startCredentialProxy({ credentials, resolveUpstream: (provider) => (provider === 'deepseek' ? model.base : undefined) })
const placeholder = proxy.env[REF] ?? ''

const connect = createLiveConnect({
  launchTimeoutMs: 180_000,
  ssh: {
    homeDir: HOME_DIR,
    authFor: async () => ({ kind: 'key' as const }),
    proxyPort: proxy.port,
    extraEnv: { DSH_HOME, DEEPSEEK_BASE_URL: '$TELEPORT_PROXY_URL/r/deepseek', DEEPSEEK_API_KEY: placeholder },
  },
})
const target: ConnectTarget = { backend: 'ssh', alias: ALIAS, port: REMOTE_PORT, remoteRoot: REMOTE_ROOT }
const config = readSshConfig({ homeDir: HOME_DIR, file: HOME_DIR + '/.ssh/config' })
const resolved = resolveSshTarget(config.parsed, ALIAS, { homeDir: HOME_DIR })
if (resolved.target === undefined) throw new Error('ssh config 里没有别名 ' + ALIAS)
const anchor = await resolveAnchorPath({ homeDir: HOME_DIR, target: resolved.target, remotePath: REMOTE_ROOT })
let live: RemoteConnection | undefined
const connectOnce = async (t: ConnectTarget): Promise<RemoteConnection> => {
  live ??= await connect(t)
  return live
}
const service = new ProjectionService({ store: new ProjectionStore(), connect: connectOnce })
const attached = await service.attach(target, { remotePath: REMOTE_ROOT, localPath: anchor.localPath })
const created = await service.createSession(attached.workspace.id)
if (live === undefined) throw new Error('attach 之后没有活连接')
await live.rpc.call<unknown>('session/prompt', {
  args: { request: { requestId: randomUUID(), sessionId: created.sessionId, mode: 'queue', content: [{ type: 'text', text: 'list your tools' }] } },
})

const deadline = Date.now() + 180_000
while (Date.now() < deadline) {
  if (model.seen.some((item) => item.path.includes('messages'))) break
  await new Promise((resolve) => setTimeout(resolve, 1000))
}
const requests = model.seen.filter((item) => item.path.includes('messages'))
record('A3-1 远端 agent 真的发出了模型请求', requests.length > 0, 'count=' + String(requests.length) + ' paths=' + JSON.stringify(requests.map((item) => item.path)))
// 取**所有**请求的工具名并集：首条 /messages 未必是带工具的那一条（标题/摘要类请求没有 tools），
// 只看第一条会把「表里有工具」误判成空表 —— 这正是本探针第一版 count=0 的原因。
const union: string[] = []
for (const item of requests) {
  for (const name of toolNames(item.body)) {
    if (!union.includes(name)) union.push(name)
  }
}
const tools = union
function topKeys(body: string): string[] {
  try { return Object.keys(JSON.parse(body) as Record<string, unknown>) } catch { return [] }
}
record('A3-1b 各请求体的顶层字段（诊断用；空数组说明 body 不是 JSON）', true, JSON.stringify(requests.map((item) => [item.path, topKeys(item.body)])))
// `dsh_plugin_packages` 是宿主自己报的「本次会话装了哪些插件包」，与 tools[] 互为佐证：
// 前者说明插件被**加载**了，后者说明它的工具真的**注册**了 —— 两者缺一都不能算 A3。
/**
 * 宿主自报的插件包名。字段形状在实测里有两种：对象数组与 JSON 字符串数组，都要认；
 * 认不出来就原样留着（宁可多一行难看的证据，也不要把它悄悄丢成「没装」）。
 */
function pluginPackages(body: string): string[] {
  const names: string[] = []
  // 只用「这个名字之前没出现过」去重，不假设数组放在哪个键下：实测这里是对象套数组再套对象，
  // 而且首版按 `raw.map(item => item.name)` 直取拿到的是一段 13KB 的 JSON 原文（字段是字符串）——
  // 报文形状不能靠猜，只能递归收。
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      // 字符串只当「可能是被序列化的数组」来试，解不开就丢掉：版本号也是字符串，
      // 无差别收集会把 `0.2.2-rc.1` 混进插件名里（第一版就这么干过）。
      try { visit(JSON.parse(value) as unknown) } catch { /* 不是 JSON：不是包名 */ }
      return
    }
    if (Array.isArray(value)) { for (const item of value) visit(item); return }
    if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>
      if (typeof record['name'] === 'string' && !names.includes(record['name'])) names.push(record['name'])
      for (const [key, item] of Object.entries(record)) {
        if (key === 'name' || key === 'version') continue
        if (typeof item === 'object' && item !== null) visit(item)
      }
    }
  }
  const push = (value: unknown): void => { visit(value) }
  try {
    const raw = (JSON.parse(body) as { dsh_plugin_packages?: unknown }).dsh_plugin_packages
    if (Array.isArray(raw)) { for (const item of raw) push(item) } else if (raw !== undefined) push(raw)
  } catch { /* body 不是 JSON：当作没有 */ }
  return names
}
const loadedPlugins = requests.flatMap((item) => pluginPackages(item.body))
record(
  'A3-1c 宿主自报的已加载插件包（非官方前缀的那几个就是「装了什么」的运行时证据）',
  true,
  'count=' + String(loadedPlugins.length) + ' extra=' + JSON.stringify(loadedPlugins.filter((item) => !item.startsWith('@deepseek-ai/'))),
)
const core = ['read', 'write', 'edit']
const hasCore = core.every((name) => tools.includes(name))
record('A3-2 工具表来自远端 agent 运行时（核心工具齐全）', hasCore, 'count=' + String(tools.length) + ' hasCore=' + String(hasCore))
// 对照工具：装卸插件时它必须一直在。否则「表里少了 web_search」可能只是整张表塌了。
const CONTROL_TOOL = process.env['CONTROL_TOOL'] ?? 'web_fetch'
record('A3-2b 对照工具仍在表里（装卸只影响目标插件）', tools.includes(CONTROL_TOOL), CONTROL_TOOL + ' included=' + String(tools.includes(CONTROL_TOOL)))
const present = tools.includes(EXPECT_TOOL)
const ok = EXPECT === 'present' ? present : !present
record(
  'A3-3 期望为 ' + EXPECT + ' 的工具 ' + EXPECT_TOOL + ' 与工具表一致',
  ok,
  'present=' + String(present) + ' tools=' + JSON.stringify(tools),
)

service.dispose()
await proxy.stop()
await model.close()

// 文件名按**原始**期望命名，且负控不落盘：负控跑的是「故意答错」，存下来只会覆盖真结果。
// （第一版按翻转后的 EXPECT 命名，负控把 installed 那份 38 工具的记录盖成了 32 —— 教训。）
const state = EXPECT_RAW === 'present' ? 'present' : 'absent'
if (!NEGATIVE) {
  try {
    writeFileSync('spikes/m2/ssh-e2e/measurements.tools.' + state + '.json', JSON.stringify({ state, expectTool: EXPECT_TOOL, controlTool: CONTROL_TOOL, loadedPlugins, tools }, null, 2) + NL)
  } catch { /* 落盘失败不影响判据 */ }
}

const failed = results.filter((item) => !item.ok)
console.log('')
console.log(String(results.length - failed.length) + '/' + String(results.length) + ' passed')
if (NEGATIVE) {
  const expected = ['A3-3']
  const actual = failed.map((item) => item.name.split(' ')[0]).sort()
  const same = JSON.stringify(actual) === JSON.stringify([...expected].sort())
  console.log('failed=' + JSON.stringify(actual) + ' expected=' + JSON.stringify([...expected].sort()))
  console.log(same ? 'NEGATIVE CONTROL OK' : 'NEGATIVE CONTROL MISMATCH')
  process.exit(same ? 0 : 1)
}
process.exit(failed.length === 0 ? 0 : 1)
