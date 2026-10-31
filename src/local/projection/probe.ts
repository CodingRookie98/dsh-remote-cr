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

import type { ProjectionRpc, StreamHandle } from './remote.ts'
import { asRecord, asString, badShape } from './shape.ts'

/** 探针命令的完成标记：独占一行出现，且不会出现在输入回显里。 */
export const PROBE_DONE = 'TELEPORT_PROBE_DONE'
/** 两个结果行的前缀；取值时**取完成标记之前最后一次出现的**，避免抓到输入回显。 */
export const PROBE_PWD = 'TELEPORT_PROBE_PWD='
export const PROBE_UNAME = 'TELEPORT_PROBE_UNAME='

/**
 * 取证命令。
 *
 * 刻意用 `printf` 加前缀而不是裸 `pwd`/`uname`：终端里回显会把整条命令行
 * 打一遍，裸输出无法与回显区分；带前缀 + 取最后一次匹配就能稳定解析。
 */
export const PROBE_COMMAND =
  "printf '" + PROBE_PWD + "%s\\n' \"$PWD\"; printf '" + PROBE_UNAME
  + "%s\\n' \"$(uname -a)\"; printf '" + PROBE_DONE + "\\n'\r"

/** 终端尺寸给足，避免长命令行被折行拆成两行。 */
export const PROBE_COLS = 200
export const PROBE_ROWS = 50
export const PROBE_TERMINAL_ID = 'teleport-probe'
export const DEFAULT_PROBE_TIMEOUT_MS = 20_000
/** 终端回滚缓冲上限：远端异常刷屏时不能把本地内存吃光。 */
export const MAX_TRANSCRIPT_CHARS = 64 * 1024

/** 取证所需的全部外部能力。 */
export interface ProbeDeps {
  readonly rpc: ProjectionRpc
}

export interface ProbeOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  /** 终端 id；同一会话重复取证会幂等命中（`terminal/create` 对同 id 幂等）。 */
  readonly terminalId?: string
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
 */
export function parseProbeTranscript(transcript: string): { cwd: string; uname: string } | undefined {
  // 先剥控制序列，再按 \r 与 \n 一起切行：PTY 的行规程把 \r 也当换行，
  // 远端回来的文本里两种都有。
  const lines = stripAnsi(transcript).split(/\r\n|\r|\n/)
  let done = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if ((lines[index] ?? '').trim() === PROBE_DONE) {
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
  // 回显行里的值是 %s（printf 的格式串），不是真实输出；宁可报错也不交假证据。
  if (cwd.includes('%s') || uname.includes('%s')) return undefined
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
  const created = await deps.rpc.call<unknown>(
    'terminal/create',
    {
      args: {
        agentId: sessionId,
        request: { id: terminalId, cols: PROBE_COLS, rows: PROBE_ROWS },
      },
    },
    options.signal,
  )
  readTerminalInfo(created, 'terminal/create')

  const gate = stopper(options.signal, options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)
  // 上行：先发一条命令，然后**保持打开**。提前 return 会让远端认为输入结束，
  // 而 attach 的下行流要等我们主动取消才会停。
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const uplink = (async function* input(): AsyncGenerator<unknown> {
    yield { type: 'write', sequence: 1, data: PROBE_COMMAND }
    await held
  })()

  let transcript = ''
  let failure: { code: string; message: string } | undefined
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
        failure = { code: 'remote/tunnel-unavailable', message: '取证命令在超时前没有回显完成标记' }
        break
      }
      if (step.done === true) break
      const event = step.value
      if (event.type === 'item') {
        transcript = clipped(transcript + frameText(event.value))
        if (parseProbeTranscript(transcript) !== undefined) break
        continue
      }
      if (event.type === 'error') failure = { code: event.code, message: event.message }
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

  const parsed = parseProbeTranscript(transcript)
  if (parsed === undefined) {
    const suffix = failure === undefined ? '' : '（远端报错 ' + failure.code + '：' + failure.message + '）'
    throw new Error('远端会话终端没有在超时前给出取证结果' + suffix + '；终端文本末尾：' + transcript.slice(-400))
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
