/**
 * S9.6 真机端到端：SSH 后端的接入 → 建会话 → 远端执行 → 断线重连 → 退出回收。
 *
 * **口径按 `docs/design/requirements.md` §7.1**（这不是可选项：口径错了测量就作废）：
 * - 首连（已有远端 dsh）≤10s：从点击「连接」到「可选目录首帧」，**明确排除远端 dsh 冷启动**
 *   （probing→provisioning→starting 三段单列报告）。所以这里把「起远端」单独记 `cold`，
 *   不进任何门禁；门禁只对**热**组生效（`disconnect` → `reconnectNow`，命中 rehandshake）。
 * - 打开工作区 ≤2s：已连着的目标上，把一份远端目录接成面板工作区。
 * - 会话创建后首个命令 ≤3s：`session.created` → 命令输出首字节。
 * - 手动重连 ≤5s：点「重连」→ 回到 connected。
 * 每项跑 ≥5 次取 P50 与 P90，两个都达标才算过；原始值全部写进 `measurements.json`。
 *
 * 为什么不走浏览器：M1 的 `p352-exit-demo` 已经证明「面板点下去真的走到产品代码」；
 * 这一片要证明的是**同一套产品代码在 SSH 后端上也成立**，浏览器只会给每次测量加
 * 1–2s 渲染抖动。所以这里直接驱动 `ProjectionService`（与 `src/index.ts` 装配同一个类、
 * 同一个 `createLiveConnect`、同一个锚点落实器）。
 *
 * 跑法：`MSYS_NO_PATHCONV=1 node spikes/m2/ssh-e2e/probe.ts [alias] [remoteRoot]`
 * 第二个参数写成不带前导斜杠的形式（`home/hui/workspace`），Git Bash 会把以 `/` 开头的
 * 参数改写成 `C:/Users/hui/workspace`。
 *
 * 负控：`NEGATIVE_CONTROL=1`。它把「远端证据」的判据换成「本机 Windows 特征」——如果这样
 * 还能全绿，说明这套断言根本区分不了「在远端跑」和「在本地跑」，测量作废。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TeleportError } from '../../../src/local/backend/errors.ts'
import { resolveAnchorPath } from '../../../src/local/backend/ssh/anchor-runtime.ts'
import { readSshConfig, resolveSshTarget } from '../../../src/local/backend/ssh/config.ts'
import { createLiveConnect } from '../../../src/local/projection/live.ts'
import { ProjectionService, type ConnectTarget, type RemoteConnection } from '../../../src/local/projection/service.ts'
import { ProjectionStore } from '../../../src/local/projection/store.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ALIAS = process.argv[2] ?? 'gcp'
const RAW_ROOT = process.env['TELEPORT_REMOTE_ROOT'] ?? process.argv[3] ?? 'home/hui/workspace'
const SAMPLES = Number(process.env['SAMPLES'] ?? '5')
const NEGATIVE = process.env['NEGATIVE_CONTROL'] === '1'
const HOME_DIR = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
const REMOTE_PORT = Number(process.env['REMOTE_PORT'] ?? '8938')

if (RAW_ROOT.includes(String.fromCharCode(92)) || /^[A-Za-z]:/.test(RAW_ROOT)) {
  console.error('remoteRoot 被改写成 Windows 路径了：' + RAW_ROOT + '（去掉前导斜杠再传）')
  process.exit(2)
}
const REMOTE_ROOT = RAW_ROOT.startsWith('/') ? RAW_ROOT : '/' + RAW_ROOT

interface Measurement { readonly name: string; readonly ok: boolean; readonly detail: string; readonly ms?: number }
const results: Measurement[] = []
function record(name: string, ok: boolean, detail: string, ms?: number): void {
  results.push(ms === undefined ? { name, ok, detail } : { name, ok, detail, ms })
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ms === undefined ? '' : ' (' + String(ms) + 'ms)') + ' — ' + detail)
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index] ?? null
}

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now()
  const value = await run()
  return { value, ms: Date.now() - started }
}

const configFile = join(HOME_DIR, '.ssh', 'config')
const config = readSshConfig({ file: configFile, homeDir: HOME_DIR })
const resolved = resolveSshTarget(config.parsed, ALIAS, { homeDir: HOME_DIR, file: configFile })
if (resolved.target === undefined) {
  console.error('没有别名 ' + ALIAS + '：' + resolved.problems.map((item) => item.message).join(' / '))
  process.exit(2)
}
const sshTarget = resolved.target
const anchor = await resolveAnchorPath({ homeDir: HOME_DIR, target: sshTarget, remotePath: REMOTE_ROOT })
const target: ConnectTarget = { backend: 'ssh', alias: ALIAS, port: REMOTE_PORT, remoteRoot: anchor.remotePath }
console.log('target: ' + ALIAS + ' → ' + sshTarget.user + '@' + sshTarget.hostName + ':' + String(sshTarget.port))
console.log('remoteRoot: ' + anchor.remotePath)
console.log('localPath: ' + anchor.localPath)

const connectLive = createLiveConnect({ ssh: { homeDir: HOME_DIR, authFor: async () => ({ kind: 'key' as const }) } })
let disposeCount = 0
function makeService(): ProjectionService {
  return new ProjectionService({
    store: new ProjectionStore(),
    connect: async (want: ConnectTarget): Promise<RemoteConnection> => {
      const connection = await connectLive(want)
      const dispose = connection.dispose.bind(connection)
      return {
        rpc: connection.rpc,
        rehandshake: connection.rehandshake === undefined ? undefined : connection.rehandshake.bind(connection),
        dispose: async () => {
          disposeCount += 1
          return dispose()
        },
      }
    },
  })
}

/** 负控把判据换成「本机 Windows 特征」：这样它必须红，否则断言区分不了远端与本地。 */
function remoteEvidence(cwd: string, uname: string): string | null {
  if (NEGATIVE) return uname.includes('Windows') ? null : '负控：只认本机 Windows 特征，实际是 ' + uname
  if (!uname.toLowerCase().includes('linux')) return 'uname 不是 Linux：' + uname
  if (cwd !== anchor.remotePath && !cwd.startsWith(anchor.remotePath + '/')) {
    return 'cwd 不在远端工作区里：' + cwd + '（期望 ' + anchor.remotePath + '）'
  }
  return null
}

interface Sample {
  readonly coldMs: number | null
  readonly openMs: number | null
  readonly sessionMs: number | null
  readonly commandMs: number | null
  readonly reconnectMs: number | null
}
const samples: Sample[] = []

for (let index = 0; index < SAMPLES; index += 1) {
  const round = String(index + 1)
  const service = makeService()
  let coldMs: number | null = null
  let openMs: number | null = null
  let sessionMs: number | null = null
  let commandMs: number | null = null
  let reconnectMs: number | null = null
  try {
    // 冷：起远端 + 建工作区。**不进任何门禁**（§7.1 明确排除远端 dsh 冷启动），只做基线记录。
    const cold = await timed(() => service.attach(target, { remotePath: anchor.remotePath, localPath: anchor.localPath }))
    coldMs = cold.ms
    const workspaceId = cold.value.workspace.id
    record('S96-cold-' + round, true, '起远端+接入 ' + workspaceId + '（单列，不做门禁）', coldMs)

    // 打开工作区 ≤2s：连接已经是活的，只把目录再接一次（远端幂等命中）。
    const opened = await timed(() => service.attach(target, { remotePath: anchor.remotePath, localPath: anchor.localPath }))
    openMs = opened.ms
    record('S96-open-' + round, opened.value.workspace.id === workspaceId, '同一工作区幂等命中（打开工作区）', openMs)

    const created = await timed(() => service.createSession(workspaceId))
    sessionMs = created.ms
    record('S96-session-' + round, true, 'session ' + created.value.sessionId, sessionMs)

    const probed = await timed(() => service.probe(created.value.sessionId))
    commandMs = probed.ms
    const bad = remoteEvidence(probed.value.cwd, probed.value.uname)
    record('S96-command-' + round, bad === null, bad ?? 'cwd=' + probed.value.cwd + ' / ' + probed.value.uname, commandMs)

    // 热组重连：断传输（远端进程留着）→ 手动重连，命中 rehandshake。
    service.disconnect()
    const reconnected = await timed(() => service.reconnectNow())
    reconnectMs = reconnected.ms
    record('S96-reconnect-' + round, service.link === 'connected', 'link=' + service.link, reconnectMs)
  } catch (error) {
    const failure = error instanceof TeleportError ? error.code + '：' + error.detail : String(error)
    record('S96-round-' + round, false, failure)
  } finally {
    // 退出回收：disconnect 只断传输，recycle 才真收远端进程（A7 不留孤儿）。
    const before = disposeCount
    const recycled = await timed(async () => {
      service.recycle()
      await new Promise((done) => setTimeout(done, 600))
      return disposeCount
    })
    record('S96-recycle-' + round, disposeCount > before, 'dispose 调用 ' + String(disposeCount) + ' 次', recycled.ms)
  }
  samples.push({ coldMs, openMs, sessionMs, commandMs, reconnectMs })
}

const pick = (key: keyof Sample): number[] =>
  samples.map((sample) => sample[key]).filter((value): value is number => value !== null)
const cell = (key: keyof Sample): { p50: number | null; p90: number | null } => ({
  p50: percentile(pick(key), 50),
  p90: percentile(pick(key), 90),
})
const summary = {
  alias: ALIAS,
  remoteRoot: anchor.remotePath,
  localPath: anchor.localPath,
  samples: samples.length,
  cold: cell('coldMs'),
  open: cell('openMs'),
  session: cell('sessionMs'),
  command: cell('commandMs'),
  reconnect: cell('reconnectMs'),
}

const GATES = [
  { key: 'openMs', limit: 2_000, label: '打开工作区 ≤2s' },
  { key: 'commandMs', limit: 3_000, label: '会话首个命令 ≤3s' },
  { key: 'reconnectMs', limit: 5_000, label: '手动重连 ≤5s（热组，即二次连接）' },
] as const
const gates: { label: string; p50: number | null; p90: number | null; limit: number; ok: boolean }[] = []
for (const gate of GATES) {
  const values = cell(gate.key)
  const ok = values.p50 !== null && values.p90 !== null && values.p50 <= gate.limit && values.p90 <= gate.limit
  gates.push({ label: gate.label, p50: values.p50, p90: values.p90, limit: gate.limit, ok })
  record('gate-' + gate.key, ok, gate.label + '：p50=' + String(values.p50) + 'ms p90=' + String(values.p90) + 'ms')
}

const failed = results.filter((item) => !item.ok).map((item) => item.name)
const out = join(HERE, NEGATIVE ? 'measurements.neg.json' : 'measurements.json')
await mkdir(HERE, { recursive: true })
await writeFile(
  out,
  JSON.stringify({ at: new Date().toISOString(), negative: NEGATIVE, summary, gates, results }, null, 2) + String.fromCharCode(10),
  'utf8',
)
console.log('')
console.log(String(results.filter((item) => item.ok).length) + '/' + String(results.length) + ' passed → ' + out)
if (NEGATIVE) {
  // 负控只赌**内容断言**能红：`remoteEvidence` 被换成「只认本机 Windows」，五轮都必须判红。
  // 不要把计时门禁也写进负控——它们量的是毫秒，判据换成什么都不影响耗时（2026-11-13 首版
  // 就是把 `gate-commandMs` 也算进必须红，结果负控自己报「测量作废」，错在负控而非产品）。
  const shouldFail = ['S96-command-1', 'S96-command-2', 'S96-command-3', 'S96-command-4', 'S96-command-5']
  const notRed = shouldFail.filter((name) => !failed.includes(name))
  const gateStillGreen = gates.every((gate) => gate.ok)
  if (notRed.length > 0) {
    console.error('负控没红：' + notRed.join(',') + ' —— 断言区分不了远端与本地，测量作废')
    process.exit(1)
  }
  if (!gateStillGreen) {
    console.error('负控还顺带把计时门禁打红了：这说明耗时测量本身不稳，先修测量再谈门禁')
    process.exit(1)
  }
  console.log('NEGATIVE CONTROL OK：五轮内容断言全红，三条计时门禁仍绿')
  process.exit(0)
}
process.exit(failed.length === 0 ? 0 : 1)