/**
 * 会话取证：在**远端会话自己的终端里**跑一条命令，拿回证据。
 *
 * 这是 M1 验收「会话首个命令在远端执行（`pwd` + `uname -a` 断言）」的落点。
 * 为什么走 `terminal/*` 而不是 `session/prompt`：
 * - `prompt` 要走模型，慢且不确定；取证需要**确定性**，一次调用一次结果；
 * - `terminal/create` 的 cwd 由远端 `workingDirectory.ensure(agent)` 决定
 *   （`terminal-controller/src/index.ts:313-349`），也就是说终端天然落在**会话的
 *   远端工作目录**里 —— 这正好是我们要断言的东西；
 * - 反过来说，如果这条命令跑在本地，`$PWD` 会是 Windows 路径、`uname` 会不存在，
 *   断言自己就会红（这就是本探针的**可假性**）。
 *
 * 三条协议约束（都来自官方实现，写错就静默卡住）：
 * 1. 上行 `TerminalInput.sequence` 从 1 起**严格连续**，跳号抛
 *    `Terminal input sequence has a gap`（`terminal.ts:114-148`）；
 * 2. `attach` 的首帧是 `snapshot`（带已序列化的屏幕），之后才是 `output`；
 * 3. 回车必须是 `\r`（PTY 的行规程只认 CR），发 `\n` 会卡在提示符上。
 */

import { randomBytes } from 'node:crypto'

import type { ProjectionRpc, StreamHandle } from './remote.ts'
import { asRecord, asString, badShape } from './shape.ts'

/**
 * 探针命令的完成标记前缀。**真正的标记每轮带一个随机后缀**（见 `newDoneToken`）。
 *
 * 为什么必须是每轮唯一的：终端是**复用**的（`terminal/create` 对同 id 幂等，见
 * `PROBE_TERMINAL_ID`），而 `terminal/attach` 的首帧 `snapshot` 会带上这个终端
 * **上一轮的整屏 scrollback**。若完成标记是固定字面量，第二次取证时首帧里就已有
 * 上一轮的 `TPDONE`，解析器当场命中，**一条命令都没发**就"成功"返回上一轮的 cwd。
 * 这不是理论推演：2026-11-01 用最小假 rpc（首帧只给含旧结果的 snapshot、此后不再
 * 产出任何 output 帧）复现，`runSessionProbe` **2ms** 就返回了旧会话的 cwd。
 *
 * 带上每轮随机后缀之后，历史 scrollback 永远不含本轮标记，假命中在结构上不可能；
 * 而"输出里出现本轮标记"仍然只能由**本轮真实执行**产生，判据强度不降反升。
 */
export const PROBE_DONE_PREFIX = 'TPDONE-'
/** 两个结果行的前缀；取值时**取完成标记之前最后一次出现的**，避免抓到输入回显。 */
export const PROBE_PWD = 'TPPWD='
export const PROBE_UNAME = 'TPUNAME='

/**
 * 取证命令。
 *
 * 刻意带前缀而不是裸 `pwd`/`uname`：终端里回显会把整条命令行打一遍，裸输出
 * 无法与回显区分；带前缀 + 取最后一次匹配就能稳定解析。
 *
 * **必须跨 shell 通用**：取证终端的 shell 由远端可用列表决定（见 `PROBE_SHELLS`），
 * 可能是 fish 也可能是 bash。所以只用两边都认的写法：`$PWD` 变量、`echo -n`、
 * 分号分隔，**不用**带命令替换的 `printf '...' "$(uname -a)"` —— fish 3.7 虽然
 * 支持 `$(...)`，但它的重绘会把带引号的长命令行拆成好几段，回显行跟着裂开
 * （实测该形态在 fish 下 6/6 解析失败，而这条 6/6 通过）。
 *
 * **命令长度不是这里的杠杆**（2026-11-01 真机对照，WSL `ubuntu_dev`，n=5/档，
 * 严格判据「某行 trim 后 === 完成标记」）：24 字符 p50 1675 / p90 1787，
 * 32 字符 1445 / 1719，66 字符 1481 / 1560 —— 全在噪声内。早先观察到「110 字符
 * 比 12 字符慢 6 倍」是**冷终端排队**造成的，不是行编辑器在给命令行上色。
 */
export function buildProbeCommand(doneToken: string): string {
  return 'echo ' + PROBE_PWD + '$PWD;echo -n ' + PROBE_UNAME + ';uname -a;echo ' + doneToken + '\r'
}

/**
 * 生成本轮唯一的完成标记。
 *
 * 只用小写十六进制：它要原样进 shell 命令，不能有任何需要转义或会被 shell 解释的字符
 * （`$` / 反引号 / 空格 / 引号一个都不能有），否则 fish 与 bash 的解释就会分叉。
 * 8 字节够用：一轮一次，碰撞概率可忽略，同时命令行只长 17 个字符。
 */
export function newDoneToken(): string {
  return PROBE_DONE_PREFIX + randomBytes(8).toString('hex')
}

/** 终端尺寸给足，避免长命令行被折行拆成两行。 */
export const PROBE_COLS = 200
export const PROBE_ROWS = 50
export const PROBE_TERMINAL_ID = 'remote-cr-probe'
export const DEFAULT_PROBE_TIMEOUT_MS = 20_000

/**
 * 取证终端优先用的 shell —— 按顺序取**远端真的装了的**第一个。
 *
 * 为什么值得换 shell：远端 bash 的 `~/.bashrc` 里有 `ble.sh`（行编辑器），它启动时
 * 要做整屏重绘、还要发 `ESC[>c`/`ESC[6n` 问终端能力并**等应答**。我们的 RPC 客户端
 * 不是真终端，不应答，于是它只能等到超时 —— 真机逐帧时间线（2026-11-01）：
 *
 * `+234ms 回显命令 → +1003ms 输出含 ESC[>c ESC[6n → +1778ms ble.sh 重绘 → +2183ms 才出现命令结果`
 *
 * 这 1.4–1.8s 与命令内容、命令长度、PTY 尺寸都无关（都做过对照），纯粹是 bash 启动。
 * 而 fish 不跑 ble.sh：同一台机器、同一条命令、同一套测量代码，
 *
 * | shell | 首命令 p50 / p90（冷终端，n=6）| n=12 复核 |
 * | --- | --- | --- |
 * | bash（默认）| 1789 / 2015 | — |
 * | fish | **204 / 406** | **150 / 161** |
 *
 * 取证是**只读的事实采集**（`$PWD` + `uname -a`），不依赖用户的交互式 shell 偏好，
 * 所以这里换 shell 不改变取证语义，只绕开远端 rc 的启动开销。
 *
 * 远端没装 fish 时回落到默认 shell，此时仍要靠下面的 `TERMINAL_WARMUP_MS` 兜底。
 */
export const PROBE_SHELL_PREFERENCE: readonly string[] = ['fish']

/**
 * 走「启动慢的 shell」（远端默认 bash + ble.sh）时，一个终端从**建立**到
 * 「能秒回命令」需要的时间。
 *
 * 这个数字不是猜的，是真机对照实测（2026-10-31 / 11-01，WSL `ubuntu_dev`，
 * 每次新会话 + 新终端，量「发命令 → 完成标记到达」）：
 *
 * | create 后已过 | 命令往返 |
 * | --- | --- |
 * | 0 ms | **1776 ms** |
 * | 500 ms | 1248 ms |
 * | 1500 ms | **364 ms** |
 * | 已跑过一条命令的终端 | **24 ms** |
 *
 * 也就是说：新建终端那一刻，远端 bash 还在跑 `~/.bashrc`（含 `ble.sh`），此时送进去
 * 的输入要排在初始化之后才被处理；**等它初始化完**再发，命令本身只要几百毫秒。
 *
 * 还试过「等首帧输出出现再发」（自适应）：首帧 705 ms 就到了，但那时初始化并未结束，
 * 命令仍要再等 818 ms。**首帧输出不是「终端就绪」的信号**。
 *
 * 注意：`PROBE_SHELL_PREFERENCE` 命中时（fish）**不需要**这段等待 —— 它没有 ble.sh，
 * 冷终端首命令只要 150 ms。等待只对回落路径生效，见 `remainingWarmup`。
 */
export const TERMINAL_WARMUP_MS = 1500

/**
 * 每个终端「什么时候建的、用的是不是快 shell」——预热窗口从这一刻起算。
 *
 * 为什么要记在这里而不是每次现等 1500ms：终端可以在**会话建立时**就建好
 * （`preheatProbe`），等用户真去点「取证」时预热窗口早就走完了，那 1500ms
 * 不必再等一遍。实测：会话建立后 1500ms 再取证，命令往返 364ms；若每次都
 * 固定睡 1500ms，则用户要多等整整一秒半。
 *
 * 键是 `sessionId:terminalId`：同一会话可以有多个终端，各算各的。
 */
const warmedAt = new Map<string, { readonly at: number; readonly warmup: boolean }>()

function warmKey(sessionId: string, terminalId: string): string {
  return sessionId + ':' + terminalId
}

/**
 * 每个会话该用哪个 shell —— 查一次就记住。
 *
 * 查一次是因为 `terminal/shells` 要走一次远端往返，而会话的 shell 集合在会话生命周期里
 * 不会变；记住还能保证「预热建的终端」和「取证复用的终端」用的是同一个 shell
 * （`terminal/create` 对同 id 幂等，选错就会拿到另一个 shell 的终端）。
 *
 * 查不到（老版本远端没这个端点、或远端报错）就**回落到默认 shell**：换 shell 是加速手段，
 * 不是取证前提，不能因为它坏了就让取证失败 —— 只是要退回去付 `TERMINAL_WARMUP_MS` 的等待。
 */
const shellChoices = new Map<string, { readonly path?: string }>()
/** 终端回滚缓冲上限：远端异常刷屏时不能把本地内存吃光。 */
export const MAX_TRANSCRIPT_CHARS = 64 * 1024

/** 取证所需的全部外部能力。 */
export interface ProbeDeps {
  readonly rpc: ProjectionRpc
}

/** 记住这个终端是什么时候建的；`terminal/create` 对同 id 幂等，已记过就不重置。 */
function markTerminalCreated(sessionId: string, terminalId: string, warmup: boolean): void {
  const key = warmKey(sessionId, terminalId)
  if (!warmedAt.has(key)) warmedAt.set(key, { at: Date.now(), warmup })
}

/**
 * 这个终端还剩多少预热窗口没走完。
 *
 * - 记过且用的是快 shell（fish）：0 —— 它没有 ble.sh，冷终端首命令 150ms。
 * - 记过且用的是默认 shell：按「建了多久」扣。
 * - 没记过（终端可能是别人建的）：按 `fallbackWarmup` 决定，即「这次会不会用默认 shell」。
 */
function remainingWarmup(sessionId: string, terminalId: string, fallbackWarmup: boolean): number {
  const created = warmedAt.get(warmKey(sessionId, terminalId))
  if (created === undefined) return fallbackWarmup ? TERMINAL_WARMUP_MS : 0
  if (!created.warmup) return 0
  const elapsed = Date.now() - created.at
  return elapsed >= TERMINAL_WARMUP_MS ? 0 : TERMINAL_WARMUP_MS - elapsed
}

/** 一次 `terminal/shells` 的结果：挑中的 shell 路径；空对象表示用远端默认。 */
interface ShellChoice {
  readonly path?: string
}

/**
 * 挑一个**远端真的装了**的快 shell（见 `PROBE_SHELL_PREFERENCE`）。
 *
 * 查一次就按会话记住：`terminal/shells` 要走一次远端往返，而可用 shell 集合在会话
 * 生命周期里不会变；更重要的是「预热建的终端」与「取证复用的终端」必须选到同一个
 * shell —— `terminal/create` 对同 id 幂等，选不一样就会拿到另一个 shell 的终端。
 *
 * 查失败（老版本远端没有这个端点、或远端报错）就**回落到默认 shell**，并且**不缓存**
 * 失败结果：换 shell 是加速手段，不是取证前提，不能让一次抖动把整个会话钉在慢路径上。
 * 只有「查成功、但确实没有偏好里的 shell」才缓存回落 —— 那个结论在会话内是稳定的。
 */
async function chooseShell(deps: ProbeDeps, sessionId: string, signal?: AbortSignal): Promise<ShellChoice> {
  const known = shellChoices.get(sessionId)
  if (known !== undefined) return known
  let listed: unknown
  try {
    listed = await deps.rpc.call<unknown>('terminal/shells', { args: { agentId: sessionId } }, signal)
  } catch {
    return {}
  }
  // 形状不对也当「这次没查到」：不缓存，下次再试。
  if (!Array.isArray(listed)) return {}
  for (const wanted of PROBE_SHELL_PREFERENCE) {
    for (const entry of listed) {
      const record = asRecord(entry)
      if (record === undefined) continue
      const path = asString(record['path'])
      if (path === undefined) continue
      // 远端给的是绝对路径（`/usr/bin/fish`），比较文件名而不是整条路径：
      // 不同发行版装在不同前缀下，整串比较会漏。
      const name = path.slice(path.lastIndexOf('/') + 1)
      if (name !== wanted) continue
      const choice: ShellChoice = { path }
      shellChoices.set(sessionId, choice)
      return choice
    }
  }
  const fallback: ShellChoice = {}
  shellChoices.set(sessionId, fallback)
  return fallback
}

/** 建终端时的公共请求体：shell 选择只影响速度，不影响取证语义。 */
function createRequest(terminalId: string, choice: ShellChoice): Record<string, unknown> {
  const request: Record<string, unknown> = { id: terminalId, cols: PROBE_COLS, rows: PROBE_ROWS }
  if (choice.path !== undefined) request['shellPath'] = choice.path
  return request
}

/**
 * 提前把取证终端建出来，让预热窗口在**用户还没点取证**的时候就开始走。
 *
 * 为什么值得单独一步：终端初始化的代价是「每个终端一次」的（实测同一终端第二条
 * 命令 24ms），而它一旦开始就不需要我们再做什么 —— 只要时间过去。会话一建好就
 * 建终端，等用户真去点「取证」时窗口早已走完，量到的就是 364ms 而不是 1776ms。
 *
 * 换成 fish 之后这段等待本身也不需要了（冷终端 150ms），但**先建终端**仍然值得：
 * 它把「建终端」的那次远端往返（实测 33–254ms）挪出用户等待窗口。
 *
 * 失败会**抛出去**，不吞：终端是取证的唯一通道，建不出终端等于取证必然失败，
 * 在会话建立时就说清楚，比让用户在取证按钮上等 20s 超时好（铁律 4「失败要响」）。
 */
export async function preheatProbe(
  deps: ProbeDeps,
  sessionId: string,
  options: { readonly terminalId?: string; readonly signal?: AbortSignal } = {},
): Promise<string> {
  const terminalId = options.terminalId ?? PROBE_TERMINAL_ID
  const choice = await chooseShell(deps, sessionId, options.signal)
  const created = await deps.rpc.call<unknown>(
    'terminal/create',
    { args: { agentId: sessionId, request: createRequest(terminalId, choice) } },
    options.signal,
  )
  readTerminalInfo(created, 'terminal/create')
  markTerminalCreated(sessionId, terminalId, choice.path === undefined)
  return terminalId
}

export interface ProbeOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  /** 终端 id；同一会话重复取证会幂等命中（`terminal/create` 对同 id 幂等）。 */
  readonly terminalId?: string
  /** 覆盖预热等待；单测与对照实验用，产品路径走 `TERMINAL_WARMUP_MS`。 */
  readonly warmupMs?: number
}

export interface ProbeResult {
  readonly sessionId: string
  readonly terminalId: string
  /** 远端会话工作目录（POSIX 绝对路径）。 */
  readonly cwd: string
  /** `uname -a` 的整行输出。 */
  readonly uname: string
  /** 截断后的完整终端文本，供「可复制日志」用。 */
  readonly transcript: string
}

function clipped(text: string): string {
  return text.length <= MAX_TRANSCRIPT_CHARS ? text : text.slice(text.length - MAX_TRANSCRIPT_CHARS)
}

/** CSI 序列（颜色、光标移动、私有模式 \u001b[?25h 等）。 */
const ANSI_CSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[ -/]*[@-~]', 'g')
/** 字符集切换，例如 \u001b(B。 */
const ANSI_CHARSET = new RegExp(String.fromCharCode(27) + '[()*+][0-9A-Za-z]', 'g')
/** 单字符转义，例如 \u001b7 / \u001b8 这类行缓冲指令。 */
const ANSI_SINGLE = new RegExp(String.fromCharCode(27) + '[=>78]', 'g')

/**
 * 去掉终端控制序列。
 *
 * 真机取证踩到的坑：远端 shell 是带主题的 zsh/bash 提示符，一段「真实输出」
 * 前面往往挂着 ESC[?25h ESC[?2004l ESC[?25h 这类控制序列，于是
 * line.startsWith(PROBE_PWD) 永远不成立 —— 解析器静默返回 undefined，
 * 探针一路等到超时，最后报成「没有回显完成标记」（症状与病因差得很远）。
 * 所以取值前必须先剥控制序列。
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI, '').replace(ANSI_CHARSET, '').replace(ANSI_SINGLE, '')
}

/**
 * 从终端文本里解析取证结果。
 *
 * 解析方向是**从后往前**：先找最后一处独占一行的完成标记，再在它之前找两个前缀
 * 最后一次出现的位置。这样输入回显（命令行本身也含前缀字面量）永远被真正的输出覆盖。
 *
 * `doneToken` 必须是**本轮**生成的（`newDoneToken`），不能是固定字面量：终端复用 +
 * snapshot 带历史 scrollback 时，固定标记会让上一轮的结论冒充本轮结论。
 */
export function parseProbeTranscript(
  transcript: string,
  doneToken: string,
): { cwd: string; uname: string } | undefined {
  // 先剥控制序列，再按 \r 与 \n 一起切行：PTY 的行规程把 \r 也当换行，
  // 远端回来的文本里两种都有。
  const lines = stripAnsi(transcript).split(/\r\n|\r|\n/)
  let done = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if ((lines[index] ?? '').trim() === doneToken) {
      done = index
      break
    }
  }
  if (done < 0) return undefined
  let cwd: string | undefined
  let uname: string | undefined
  for (let index = done - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? '').trim()
    if (uname === undefined && line.startsWith(PROBE_UNAME)) uname = line.slice(PROBE_UNAME.length)
    else if (cwd === undefined && line.startsWith(PROBE_PWD)) cwd = line.slice(PROBE_PWD.length)
    if (cwd !== undefined && uname !== undefined) break
  }
  if (cwd === undefined || uname === undefined) return undefined
  // 回显行里留着的是**字面量**（`$PWD`、`%s` 这类），不是真实输出；
  // 宁可报错也不交假证据 —— 一旦把它们当成结果，断言会「通过」得毫无意义。
  if (cwd.includes('$PWD') || cwd.includes('%s')) return undefined
  if (uname.includes('$(') || uname.includes('%s')) return undefined
  return { cwd, uname }
}

function readTerminalInfo(value: unknown, endpoint: string): string {
  const record = asRecord(value)
  if (record === undefined) badShape(endpoint, '不是一个对象')
  const id = asString(record['id'])
  if (id === undefined) badShape(endpoint, 'id 不是非空字符串')
  return id
}

/** 从一帧 `TerminalFrame` 里取出可读文本。 */
function frameText(value: unknown): string {
  const record = asRecord(value)
  if (record === undefined) return ''
  const kind = asString(record['type'])
  if (kind === 'snapshot') {
    const screen = asString(record['screen'])
    return screen === undefined ? '' : screen + '\n'
  }
  if (kind === 'output') {
    const data = asString(record['data'])
    return data ?? ''
  }
  return ''
}

/** 可被 signal 打断的等待；取消时立刻返回，不留下悬空定时器。 */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', done)
      resolve()
    }, ms)
    timer.unref?.()
    const done = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** 超时哨兵：与 `iterator.next()` 赛跑，谁先到谁说了算。 */
const TIMEOUT = Symbol('probe-timeout')

/**
 * 与一个 promise 赛跑，超时或外部取消时返回 `TIMEOUT`。
 *
 * 为什么不用 `AbortSignal` 直接取消流：`ProjectionRpc.openStream` 的签名里没有
 * signal（官方 `RpcStreamOpen` 也没有），取消只能靠 `iterator.return()`。
 * 所以闸门做在消费侧，并且**必须显式 `return()`**，否则 WS 会一直挂着。
 */
async function raceGate<T>(
  promise: Promise<T>,
  gate: { readonly signal: AbortSignal },
): Promise<T | typeof TIMEOUT> {
  let stop: (() => void) | undefined
  const aborted = new Promise<typeof TIMEOUT>((resolve) => {
    stop = () => resolve(TIMEOUT)
    if (gate.signal.aborted) stop()
    else gate.signal.addEventListener('abort', stop, { once: true })
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    if (stop !== undefined) gate.signal.removeEventListener('abort', stop)
  }
}

/** 超时 / 外部取消的闸门。 */
function stopper(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('probe timeout')), timeoutMs)
  timer.unref?.()
  const relay = (): void => controller.abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', relay, { once: true })
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', relay)
    },
  }
}

/**
 * 在远端会话的终端里跑一次取证命令。
 *
 * 终端用完**不删**（`terminal/close`）：它是用户能看到的证据，删掉反而让人无法复核。
 * 同一 `terminalId` 重复调用会复用同一个终端（`terminal/create` 幂等），
 * 所以反复取证不会把远端终端数量刷到上限。
 */
export async function runSessionProbe(
  deps: ProbeDeps,
  sessionId: string,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const terminalId = options.terminalId ?? PROBE_TERMINAL_ID
  const choice = await chooseShell(deps, sessionId, options.signal)
  // 先查预热余量**再**建终端：`terminal/create` 幂等，已经建过的终端
  // （`preheatProbe` 建过）不该在这里把计时重置回 0。
  const pendingWarmup = options.warmupMs ?? remainingWarmup(sessionId, terminalId, choice.path === undefined)
  const created = await deps.rpc.call<unknown>(
    'terminal/create',
    { args: { agentId: sessionId, request: createRequest(terminalId, choice) } },
    options.signal,
  )
  readTerminalInfo(created, 'terminal/create')
  markTerminalCreated(sessionId, terminalId, choice.path === undefined)

  // 预热：等远端 shell 把 `~/.bashrc`（含 ble.sh）跑完再发命令。
  // 数字的依据与对照实验见 `TERMINAL_WARMUP_MS` 的注释。走 fish 时这里是 0
  // （它没有 ble.sh，冷终端首命令 150ms）；只有回落到默认 shell 才真要等。
  if (pendingWarmup > 0) await pause(pendingWarmup, options.signal)

  // 完成标记**每轮新生成**：终端是复用的，首帧 snapshot 会带回上一轮的整屏文本，
  // 固定标记会让上一轮的结论冒充本轮（见 `PROBE_DONE_PREFIX` 的注释）。
  const doneToken = newDoneToken()
  const command = buildProbeCommand(doneToken)

  const gate = stopper(options.signal, options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)
  // 上行：先发一条命令，然后**保持打开**。提前 return 会让远端认为输入结束，
  // 而 attach 的下行流要等我们主动取消才会停。
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const uplink = (async function* input(): AsyncGenerator<unknown> {
    yield { type: 'write', sequence: 1, data: command }
    await held
  })()

  let transcript = ''
  let failure: { code: string; message: string } | undefined
  /**
   * 为什么停下来。三者对用户的含义完全不同，不能都报成「超时」：
   * `timeout` 是远端没吭声，`closed` 是流提前没了（隧道掉了／终端被关），
   * `error` 是远端明确报错。混成一句会让排障从「看远端」变成「等更久」。
   */
  let stopped: 'timeout' | 'closed' | 'error' = 'closed'
  const stream: StreamHandle = deps.rpc.openStream(
    'terminal/attach',
    { args: { agentId: sessionId, id: terminalId } },
    uplink,
  )
  const iterator = stream[Symbol.asyncIterator]()
  try {
    for (;;) {
      const step = await raceGate(iterator.next(), gate)
      if (step === TIMEOUT) {
        stopped = 'timeout'
        failure = { code: 'remote/tunnel-unavailable', message: '取证命令在超时前没有回显完成标记' }
        break
      }
      if (step.done === true) {
        stopped = 'closed'
        break
      }
      const event = step.value
      if (event.type === 'item') {
        transcript = clipped(transcript + frameText(event.value))
        if (parseProbeTranscript(transcript, doneToken) !== undefined) break
        continue
      }
      if (event.type === 'error') {
        stopped = 'error'
        failure = { code: event.code, message: event.message }
      }
      break
    }
  } finally {
    // **必须**先 cancel 再 return：生成器可能正停在「等下一帧」的 await 上，
    // 那种状态下 iterator.return() 会一直排队不结算（真机卡死二十几分钟的那次）。
    stream.cancel()
    await iterator.return?.(undefined)?.catch(() => undefined)
    release?.()
    gate.dispose()
  }

  const parsed = parseProbeTranscript(transcript, doneToken)
  if (parsed === undefined) {
    const because =
      stopped === 'timeout'
        ? '没有在超时前给出本轮取证结果'
        : stopped === 'closed'
          ? '的输出流在本轮完成标记出现前就结束了'
          : '报错后没有给出本轮取证结果'
    const suffix = failure === undefined ? '' : '（远端 ' + failure.code + '：' + failure.message + '）'
    throw new Error('远端会话终端' + because + suffix + '；终端文本末尾：' + transcript.slice(-400))
  }
  return { sessionId, terminalId, cwd: parsed.cwd, uname: parsed.uname, transcript }
}

/** 会话首个命令是否**真的**跑在远端：cwd 是 POSIX 绝对路径，且内核串是 Linux。 */
export function assertRemoteExecution(result: ProbeResult): { readonly cwd: string; readonly uname: string } {
  if (!result.cwd.startsWith('/')) {
    throw new Error('会话命令没有跑在远端：$PWD 是 ' + JSON.stringify(result.cwd) + '，不是 POSIX 绝对路径')
  }
  if (/^[A-Za-z]:/.test(result.cwd) || result.cwd.includes('\\')) {
    throw new Error('会话命令没有跑在远端：$PWD 是 Windows 路径 ' + JSON.stringify(result.cwd))
  }
  if (!/Linux/i.test(result.uname)) {
    throw new Error('会话命令没有跑在远端：uname 输出 ' + JSON.stringify(result.uname) + ' 不含 Linux')
  }
  return { cwd: result.cwd, uname: result.uname }
}
