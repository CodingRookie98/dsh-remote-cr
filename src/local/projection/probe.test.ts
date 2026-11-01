import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ProjectionRpc, StreamEvent, StreamHandle } from './remote.ts'
import {
  PROBE_COMMAND,
  PROBE_DONE,
  PROBE_PWD,
  PROBE_SHELL_PREFERENCE,
  PROBE_UNAME,
  TERMINAL_WARMUP_MS,
  assertRemoteExecution,
  parseProbeTranscript,
  runSessionProbe,
} from './probe.ts'

const NEG = process.env.NEGATIVE_CONTROL === '1'

/**
 * 单测一律跳过预热等待。
 *
 * `TERMINAL_WARMUP_MS` 是**真机事实**（create 后等 1500ms 才发命令，见 probe.ts
 * 里的对照表），不是这里要验证的行为；等它只会让测试白慢 1.5s。
 * 它自己的约束由下面那条「必须为正」的断言守住。
 */
const NO_WARMUP = { warmupMs: 0 }

/** 造一段终端文本：先是 shell 回显（含 %s 字面量），再是真实输出。 */
function transcriptOf(cwd: string, uname: string, options: { echo?: boolean; done?: boolean } = {}): string {
  const echo = options.echo ?? true
  const lines: string[] = []
  if (echo) lines.push('hui@CodingRookie:~$ ' + PROBE_COMMAND.replace('\r', ''))
  lines.push(PROBE_PWD + cwd)
  lines.push(PROBE_UNAME + uname)
  if (options.done ?? true) lines.push(PROBE_DONE)
  return lines.join('\r\n') + '\r\n'
}

const LINUX_UNAME = 'Linux CodingRookie 6.18.54.1-microsoft-standard-WSL2 x86_64 GNU/Linux'

test('解析取完成标记之前的最后一次出现：回显行里的 %s 不会被当成结果', () => {
  const text = transcriptOf('/home/hui/workspace', LINUX_UNAME)
  // NEGATIVE_CONTROL: 变异成「从头往后取第一次出现」，就会抓到回显里的 printf 格式串。
  const parsed = NEG ? firstMatch(text) : parseProbeTranscript(text)
  assert.notEqual(parsed, undefined)
  assert.equal(parsed?.cwd, '/home/hui/workspace')
  assert.equal(parsed?.uname, LINUX_UNAME)
})

/** 负控用的错误解析：正序取第一次出现（会命中回显）。 */
function firstMatch(text: string): { cwd: string; uname: string } | undefined {
  let cwd: string | undefined
  let uname: string | undefined
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (cwd === undefined && line.includes(PROBE_PWD)) cwd = line.slice(line.indexOf(PROBE_PWD) + PROBE_PWD.length)
    else if (uname === undefined && line.includes(PROBE_UNAME)) uname = line.slice(line.indexOf(PROBE_UNAME) + PROBE_UNAME.length)
  }
  if (cwd === undefined || uname === undefined) return undefined
  return { cwd, uname }
}

test('没有完成标记就不给结论：宁可报错也不交半截证据', () => {
  assert.equal(parseProbeTranscript(transcriptOf('/home/hui', LINUX_UNAME, { done: false })), undefined)
  assert.equal(parseProbeTranscript(''), undefined)
})

test('只有回显、没有真实输出时解析失败（回显里是 $PWD 字面量，不是值）', () => {
  // 回显行会原样打出命令行，其中 `$PWD` 没有被展开；把它当成结果就是假证据。
  const echoOnly = 'hui@CodingRookie:~$ ' + PROBE_COMMAND.replace('\r', '') + '\r\n' + PROBE_DONE + '\r\n'
  assert.equal(parseProbeTranscript(echoOnly), undefined)
  // 就算回显被折行、前缀单独落在某一行，也不能认。
  assert.equal(parseProbeTranscript(PROBE_PWD + '$PWD\r\n' + PROBE_UNAME + '$(uname -a)\r\n' + PROBE_DONE), undefined)
})

test('断言：POSIX 绝对路径 + Linux 内核才算跑在远端', () => {
  const ok = { sessionId: 's1', terminalId: 't', cwd: '/home/hui/workspace', uname: LINUX_UNAME, transcript: '' }
  assert.deepEqual(assertRemoteExecution(ok), { cwd: '/home/hui/workspace', uname: LINUX_UNAME })

  assert.throws(() => assertRemoteExecution({ ...ok, cwd: 'D:\\workspace' }), /没有跑在远端/)
  assert.throws(() => assertRemoteExecution({ ...ok, cwd: 'C:/workspace' }), /没有跑在远端/)
  assert.throws(() => assertRemoteExecution({ ...ok, uname: 'MINGW64_NT-10.0-22631' }), /没有跑在远端/)
})

interface Recorded {
  readonly calls: { endpoint: string; payload: unknown }[]
  readonly streams: { endpoint: string; payload: unknown; uplink: boolean }[]
}

/** 假 RPC：把「远端回了什么」变成测试入参，而不是去连真远端。 */
function fakeRpc(
  frames: readonly unknown[],
  options: { readonly failWith?: { code: string; message: string }; readonly shells?: readonly unknown[] | Error } = {},
): { rpc: ProjectionRpc; seen: Recorded } {
  const seen: Recorded = { calls: [], streams: [] }
  const rpc: ProjectionRpc = {
    async call<T>(endpoint: string, payload: unknown): Promise<T> {
      seen.calls.push({ endpoint, payload })
      if (endpoint === 'terminal/shells') {
        if (options.shells instanceof Error) throw options.shells
        return (options.shells ?? []) as T
      }
      return { id: 'teleport-probe', title: 'probe', shell: 'bash', cwd: '/home/hui', cols: 200, rows: 50, state: 'running', exitCode: null } as T
    },
    openStream(endpoint: string, payload: unknown, uplink?: AsyncIterable<unknown>): StreamHandle {
      seen.streams.push({ endpoint, payload, uplink: uplink !== undefined })
      let cancelled = false
      return {
        cancel() {
          cancelled = true
        },
        async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
          for (const frame of frames) {
            if (cancelled) return
            yield { type: 'item', value: frame }
          }
          if (options.failWith !== undefined) yield { type: 'error', ...options.failWith }
          else yield { type: 'end' }
        },
      }
    },
  }
  return { rpc, seen }
}

test('runSessionProbe 走 terminal/create + terminal/attach，agentId 用 sessionId 且带 request', async () => {
  const { rpc, seen } = fakeRpc([
    { type: 'snapshot', sequence: 1, screen: '', info: { id: 'teleport-probe' }, writable: true },
    { type: 'output', sequence: 2, data: transcriptOf('/home/hui/workspace', LINUX_UNAME) },
  ])
  const result = await runSessionProbe({ rpc }, 'sess-1', NO_WARMUP)
  assert.equal(result.cwd, '/home/hui/workspace')
  assert.equal(result.uname, LINUX_UNAME)

  assert.deepEqual(seen.calls.map((entry) => entry.endpoint), ['terminal/shells', 'terminal/create'])
  const create = seen.calls[1]?.payload as { args: { agentId: string; request: { id: string; cols: number; rows: number } } }
  assert.equal(create.args.agentId, 'sess-1', 'agent 的线上身份就是 sessionId')
  assert.equal(create.args.request.id, 'teleport-probe')

  assert.deepEqual(seen.streams.map((entry) => entry.endpoint), ['terminal/attach'])
  assert.equal(seen.streams[0]?.uplink, true, '不带上行就发不出命令')
})

test('预热必须真的等：warmupMs 到点之前不发命令，到点之后才发', async () => {
  const { rpc, seen } = fakeRpc([
    { type: 'snapshot', sequence: 1, screen: '' },
    { type: 'output', sequence: 2, data: transcriptOf('/home/hui/workspace', LINUX_UNAME) },
  ])
  const startedAt = Date.now()
  await runSessionProbe({ rpc }, 'sess-1', { warmupMs: 120 })
  const waited = Date.now() - startedAt
  // 留 40ms 余量：定时器可能提前一点点唤醒，但不该差出一个数量级。
  assert.ok(waited >= 80, '预热 120ms 却只等了 ' + String(waited) + 'ms，说明等待被跳过了')
  assert.equal(seen.streams.length, 1, '等待期间不该已经开出 attach 流')
})

test('预热被取消时立刻收手，不把整条取证拖到超时', async () => {
  const { rpc } = fakeRpc([])
  const controller = new AbortController()
  controller.abort(new Error('用户取消'))
  const startedAt = Date.now()
  await assert.rejects(runSessionProbe({ rpc }, 'sess-1', { warmupMs: 5000, signal: controller.signal }))
  assert.ok(Date.now() - startedAt < 2000, '已取消的 signal 不该再等满预热')
})

test('预热常量必须是正数：它承载的是「远端 shell 初始化没结束就别发命令」这条事实', () => {
  assert.ok(TERMINAL_WARMUP_MS > 0)
  assert.ok(TERMINAL_WARMUP_MS >= 1000, '实测 1500ms 才稳定，写小了首命令会退回 2.7s')
})

test('远端装了 fish 就用 fish 建取证终端：快 shell 比等 1500ms 更省', async () => {
  const { rpc, seen } = fakeRpc(
    [
      { type: 'snapshot', sequence: 1, screen: '' },
      { type: 'output', sequence: 2, data: transcriptOf('/home/hui/workspace', LINUX_UNAME) },
    ],
    { shells: [{ path: '/bin/bash', name: 'bash', args: ['-i'] }, { path: '/usr/bin/fish', name: 'fish', args: ['-i'] }] },
  )
  await runSessionProbe({ rpc }, 'sess-fish', NO_WARMUP)
  const create = seen.calls[1]?.payload as { args: { request: { shellPath?: string } } }
  assert.equal(create.args.request.shellPath, '/usr/bin/fish', '偏好列表里第一个装了的就要用它')
})

test('远端没装偏好 shell 就不指定 shellPath，交给远端默认', async () => {
  const { rpc, seen } = fakeRpc(
    [
      { type: 'snapshot', sequence: 1, screen: '' },
      { type: 'output', sequence: 2, data: transcriptOf('/home/hui/workspace', LINUX_UNAME) },
    ],
    { shells: [{ path: '/bin/bash', name: 'bash', args: ['-i'] }] },
  )
  await runSessionProbe({ rpc }, 'sess-bashonly', NO_WARMUP)
  const create = seen.calls[1]?.payload as { args: { request: { shellPath?: string } } }
  assert.equal(create.args.request.shellPath, undefined, '不装就别瞎指定，否则远端会拒')
})

test('查 shell 列表失败要回落默认 shell，不能让取证跟着挂', async () => {
  const { rpc, seen } = fakeRpc(
    [
      { type: 'snapshot', sequence: 1, screen: '' },
      { type: 'output', sequence: 2, data: transcriptOf('/home/hui/workspace', LINUX_UNAME) },
    ],
    { shells: new Error('老版本远端没有 terminal/shells') },
  )
  const result = await runSessionProbe({ rpc }, 'sess-old', NO_WARMUP)
  assert.equal(result.cwd, '/home/hui/workspace')
  const create = seen.calls[1]?.payload as { args: { request: { shellPath?: string } } }
  assert.equal(create.args.request.shellPath, undefined)
})

test('回落到默认 shell 时才等预热；用快 shell 不等', async () => {
  const frames = [
    { type: 'snapshot', sequence: 1, screen: '' },
    { type: 'output', sequence: 2, data: transcriptOf('/home/hui/workspace', LINUX_UNAME) },
  ]
  const slow = fakeRpc(frames, { shells: [] })
  const slowStart = Date.now()
  await runSessionProbe({ rpc: slow.rpc }, 'sess-slow')
  const slowWaited = Date.now() - slowStart
  assert.ok(slowWaited >= TERMINAL_WARMUP_MS - 200, '默认 shell 必须等满预热，实测只等了 ' + String(slowWaited) + 'ms')

  const fast = fakeRpc(frames, { shells: [{ path: '/usr/bin/fish', name: 'fish', args: ['-i'] }] })
  const fastStart = Date.now()
  await runSessionProbe({ rpc: fast.rpc }, 'sess-fast')
  const fastWaited = Date.now() - fastStart
  assert.ok(fastWaited < 500, '快 shell 不该再等预热，实测等了 ' + String(fastWaited) + 'ms')
})

test('偏好列表非空：空列表等于「永远走慢路径」，是配置错误', () => {
  assert.ok(PROBE_SHELL_PREFERENCE.length > 0)
})

test('远端报错且没给结果时，错误里带得上远端 code（不吞成「超时」）', async () => {
  const { rpc } = fakeRpc([{ type: 'snapshot', sequence: 1, screen: '' }], {
    failWith: { code: 'terminal/not-found', message: '没有这个终端' },
  })
  await assert.rejects(runSessionProbe({ rpc }, 'sess-1', NO_WARMUP), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /terminal\/not-found/)
    return true
  })
})