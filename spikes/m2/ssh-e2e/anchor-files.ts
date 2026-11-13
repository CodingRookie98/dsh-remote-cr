/**
 * M2 出口门槛 3：锚点工作区里 `read` 读到的是**远端**文件，`write`/`edit` 走同一条映射。
 *
 * 为什么不能只验证 read：B 型里 agent 整个跑在远端，`read` 天然读远端 —— 它几乎不可能错。
 * 真正会错的是**映射**：会话的 cwd 是远端路径，工具解析出来的绝对路径必须还是那个远端路径，
 * 写下去的东西必须落在远端的那个文件上。所以这里让远端模型（本机的假上游扮演）真的调
 * read/write/edit 三个工具，再由**进程外**的 `ssh cat` 复验结果 —— 工具自己说成功不算证据。
 *
 * 假上游要说得像 Anthropic 的流：message_start → content_block_start(tool_use) →
 * input_json_delta → content_block_stop → message_delta(stop_reason=tool_use) → message_stop。
 * 轮次靠请求体里 `tool_result` 出现的次数推进（每执行完一个工具就多一个）。
 *
 * 跑法：`MSYS_NO_PATHCONV=1 node spikes/m2/ssh-e2e/anchor-files.ts [alias] [remoteRoot]`
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { LocalCredentials } from '../../../src/local/proxy/credentials.ts'
import { startCredentialProxy } from '../../../src/local/proxy/runtime.ts'
import { createLiveConnect } from '../../../src/local/projection/live.ts'
import { ProjectionService } from '../../../src/local/projection/service.ts'
import { ProjectionStore } from '../../../src/local/projection/store.ts'
import { resolveAnchorPath } from '../../../src/local/backend/ssh/anchor-runtime.ts'
import { readSshConfig, resolveSshTarget } from '../../../src/local/backend/ssh/config.ts'
import type { ConnectTarget, RemoteConnection } from '../../../src/local/projection/service.ts'

const ALIAS = process.argv[2] ?? 'gcp'
const RAW_ROOT = process.argv[3] ?? 'home/hui/workspace'
const REMOTE_ROOT = RAW_ROOT.startsWith('/') ? RAW_ROOT : '/' + RAW_ROOT
const HOME_DIR = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
const REMOTE_PORT = Number(process.env['REMOTE_PORT'] ?? '8955')
const DSH_HOME = process.env['REMOTE_DSH_HOME'] ?? '/tmp/teleport-gate3/dshhome'
const REF = 'DEEPSEEK_API_KEY'
const REAL_VALUE = 'sk-real-gate3-anchor'
/**
 * 负控：不往远端布夹具文件，并把写目标指到一个远端并不存在的目录。
 * 期望变红的正是「读到远端」「写到远端」「改在远端」这三类断言；AF-0/1/2 仍应绿。
 */
const NEGATIVE = process.env['NEGATIVE_CONTROL'] === '1'
// 指望「目录不存在」让写失败是错的：write 工具会自己建父目录，实测照绿。
// 要真正写不进去，得挑一个只读文件系统上的路径。
const ANCHOR_FILE = NEGATIVE ? '/proc/.teleport-gate3-anchor.txt' : REMOTE_ROOT + '/.teleport-gate3-anchor.txt'
const NONCE = randomUUID().slice(0, 8)
/** 远端才有的那个文件：本机既没这个路径，也无法猜到内容里的 nonce。 */
const REMOTE_ONLY_FILE = '/tmp/teleport-gate3-remote-' + NONCE + '.txt'
// 不带换行：经 JSON.stringify 传给 printf 时，'\n' 会变成字面的反斜杠 n，远端内容就对不上了。
const REMOTE_ONLY_BODY = 'remote-only-' + NONCE
const WRITTEN = 'written-by-remote-agent'
const EDITED = 'edited-by-remote-agent'

interface Measurement { readonly name: string; readonly ok: boolean; readonly detail: string }
const results: Measurement[] = []
function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail })
  console.log((ok ? '  ok   ' : '  FAIL ') + name + ' — ' + detail)
}

interface Step { readonly name: 'read' | 'write' | 'edit'; readonly input: Record<string, unknown> }
const steps: Step[] = [
  { name: 'read', input: { file_path: REMOTE_ONLY_FILE } },
  { name: 'write', input: { file_path: ANCHOR_FILE, content: WRITTEN + '\n' } },
  { name: 'read', input: { file_path: ANCHOR_FILE } },
  { name: 'edit', input: { file_path: ANCHOR_FILE, old_string: WRITTEN, new_string: EDITED } },
  { name: 'read', input: { file_path: ANCHOR_FILE } },
]

function sse(res: import('node:http').ServerResponse, events: unknown[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const event of events) res.write('event: ' + String((event as { type: string }).type) + '\ndata: ' + JSON.stringify(event) + '\n\n')
  res.end()
}

function toolUseEvents(index: number, step: Step): unknown[] {
  return [
    { type: 'message_start', message: { id: 'msg-' + String(index), role: 'assistant', usage: { input_tokens: 7, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu-' + String(index), name: step.name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.input) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
    { type: 'message_stop' },
  ]
}

function textEvents(index: number, text: string): unknown[] {
  return [
    { type: 'message_start', message: { id: 'msg-final-' + String(index), role: 'assistant', usage: { input_tokens: 7, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ]
}

interface Seen { readonly path: string; readonly body: string; readonly results: string[] }

/**
 * 只取 tool_result 的正文。整个请求体里也含着模型自己写的 tool_use 入参，
 * 拿整包做 includes 会让「读写闭环」恒真 —— 这是第一版假绿的原因。
 */
function toolResultTexts(body: string): string[] {
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return [] }
  const texts: string[] = []
  const messages = (parsed as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return texts
  for (const message of messages) {
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if ((block as { type?: string }).type !== 'tool_result') continue
      texts.push(JSON.stringify((block as { content?: unknown }).content))
    }
  }
  return texts
}
async function startFakeModel(): Promise<{ base: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      seen.push({ path: req.url ?? '/', body, results: toolResultTexts(body) })
      if (!(req.url ?? '').includes('messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [] }))
        return
      }
      const done = (body.match(/"type":"tool_result"/g) ?? []).length
      const step = steps[done]
      sse(res, step === undefined ? textEvents(done, 'all steps dispatched') : toolUseEvents(done, step))
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
record('AF-0 ssh 通道可用（拿得到远端主机名）', remoteHostname !== '', remoteHostname)
// 远端先自己写一份「只有远端才有」的文件：内容含本机随机生成的 nonce，
// 于是「agent 读到了它」这件事既不可能靠本地缓存蒙对，也不可能靠猜。
const seeded = NEGATIVE
  ? { code: 1, stdout: '' }
  : await sshRun('printf %s ' + JSON.stringify(REMOTE_ONLY_BODY) + ' > ' + REMOTE_ONLY_FILE)
const seededBack = await sshRun('cat ' + REMOTE_ONLY_FILE)
record('AF-0b 远端已布好只存在于远端的夹具文件', seeded.code === 0 && seededBack.stdout.trim() === REMOTE_ONLY_BODY, REMOTE_ONLY_FILE + ' body=' + JSON.stringify(seededBack.stdout.trim()))
const localHasSamePath = existsSync(ANCHOR_FILE)
record('AF-1 这个锚点路径在本机不存在（否则「读到远端」无从判断）', !localHasSamePath, ANCHOR_FILE + ' local=' + String(localHasSamePath))

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
// 走产品路径，不直连 `session/create`：锚点目录 → `workspace/create` → 会话。
// 这条路径上「本地锚点」与「远端路径」是两份不同的字符串，映射错位只有在这里才暴露。
const config = readSshConfig({ homeDir: HOME_DIR, file: HOME_DIR + '/.ssh/config' })
const resolved = resolveSshTarget(config.parsed, ALIAS, { homeDir: HOME_DIR })
if (resolved.target === undefined) throw new Error('ssh config 里没有别名 ' + ALIAS)
const anchor = await resolveAnchorPath({ homeDir: HOME_DIR, target: resolved.target, remotePath: REMOTE_ROOT })
// 只开一条连接：`attach` 与后面发 prompt 用的必须是同一个 rpc（换连接会换 cookie）。
let live: RemoteConnection | undefined
const connectOnce = async (t: ConnectTarget): Promise<RemoteConnection> => {
  live ??= await connect(t)
  return live
}
const service = new ProjectionService({ store: new ProjectionStore(), connect: connectOnce })
const attached = await service.attach(target, { remotePath: REMOTE_ROOT, localPath: anchor.localPath })
record(
  'AF-2 经产品路径接入：锚点目录在本地建出来、远端工作区指向远端路径',
  attached.workspace.remotePath === REMOTE_ROOT && attached.workspace.localPath === anchor.localPath && existsSync(anchor.localPath),
  'remote=' + String(attached.workspace.remotePath) + ' local=' + attached.workspace.localPath + ' exists=' + String(existsSync(anchor.localPath)),
)
const created = await service.createSession(attached.workspace.id)
const sessionId = created.sessionId
if (live === undefined) throw new Error('attach 之后没有活连接')
const rpc = live.rpc
record('AF-2b 在锚点工作区里建出了会话', sessionId !== '', sessionId)

await rpc.call<unknown>('session/prompt', {
  args: { request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: 'run the scripted tool steps' }] } },
})

const deadline = Date.now() + 240_000
while (Date.now() < deadline) {
  if (model.seen.some((item) => item.body.includes('all steps dispatched') || item.body.includes('"stop_reason":"end_turn"'))) break
  if ((model.seen.at(-1)?.body.match(/"type":"tool_result"/g) ?? []).length > steps.length) break
  await new Promise((resolve) => setTimeout(resolve, 1000))
}

const allBodies = model.seen.map((item) => item.body).join('\n')
const readRemoteOnly = REMOTE_ONLY_BODY !== '' && allBodies.includes(REMOTE_ONLY_BODY)
record('AF-3 read 读到的是那个只存在于远端的文件（内容含本机 nonce）', readRemoteOnly, 'nonce=' + NONCE)

const remoteFile = await sshRun('cat ' + ANCHOR_FILE + ' 2>/dev/null')
record('AF-4 write 落到了远端那个路径上', remoteFile.stdout.trim() === EDITED, JSON.stringify(remoteFile.stdout.trim()))
record('AF-5 edit 把内容改成了新值（同一文件、同一映射）', remoteFile.stdout.includes(EDITED) && !remoteFile.stdout.includes(WRITTEN), String(remoteFile.code))
const toolResults = model.seen.flatMap((item) => item.results).join('\n')
const readBack = toolResults.includes(WRITTEN) && toolResults.includes(EDITED)
record('AF-6 read 读回了刚写的内容（读写走同一映射）', readBack, 'written=' + String(toolResults.includes(WRITTEN)) + ' edited=' + String(toolResults.includes(EDITED)))

await sshRun('rm -f ' + ANCHOR_FILE + ' ' + REMOTE_ONLY_FILE)
service.dispose()
await proxy.stop()
await model.close()

const failed = results.filter((item) => !item.ok)
console.log('')
console.log(String(results.length - failed.length) + '/' + String(results.length) + ' passed')
if (NEGATIVE) {
  // 负控的判据是**失败集恰好等于期望集**：多红一条说明断言互相串了，少红一条说明有一条是空的。
  const expected = ['AF-0b', 'AF-3', 'AF-4', 'AF-5', 'AF-6']
  const actual = failed.map((item) => item.name.split(' ')[0]).sort()
  const same = JSON.stringify(actual) === JSON.stringify([...expected].sort())
  console.log('failed=' + JSON.stringify(actual) + ' expected=' + JSON.stringify([...expected].sort()))
  console.log(same ? 'NEGATIVE CONTROL OK' : 'NEGATIVE CONTROL MISMATCH')
  process.exit(same ? 0 : 1)
}
process.exit(failed.length === 0 ? 0 : 1)