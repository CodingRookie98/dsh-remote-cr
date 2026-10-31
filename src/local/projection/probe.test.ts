import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ProjectionRpc, StreamEvent, StreamHandle } from './remote.ts'
import {
  PROBE_COMMAND,
  PROBE_DONE,
  PROBE_PWD,
  PROBE_UNAME,
  assertRemoteExecution,
  parseProbeTranscript,
  runSessionProbe,
} from './probe.ts'

const NEG = process.env.NEGATIVE_CONTROL === '1'

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

test('只有回显、没有真实输出时解析失败（%s 是 printf 的格式串，不是值）', () => {
  const echoOnly = 'hui@CodingRookie:~$ ' + PROBE_COMMAND.replace('\r', '') + '\r\n' + PROBE_DONE + '\r\n'
  assert.equal(parseProbeTranscript(echoOnly), undefined)
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
function fakeRpc(frames: readonly unknown[], options: { readonly failWith?: { code: string; message: string } } = {}): { rpc: ProjectionRpc; seen: Recorded } {
  const seen: Recorded = { calls: [], streams: [] }
  const rpc: ProjectionRpc = {
    async call<T>(endpoint: string, payload: unknown): Promise<T> {
      seen.calls.push({ endpoint, payload })
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
  const result = await runSessionProbe({ rpc }, 'sess-1')
  assert.equal(result.cwd, '/home/hui/workspace')
  assert.equal(result.uname, LINUX_UNAME)

  assert.deepEqual(seen.calls.map((entry) => entry.endpoint), ['terminal/create'])
  const create = seen.calls[0]?.payload as { args: { agentId: string; request: { id: string; cols: number; rows: number } } }
  assert.equal(create.args.agentId, 'sess-1', 'agent 的线上身份就是 sessionId')
  assert.equal(create.args.request.id, 'teleport-probe')

  assert.deepEqual(seen.streams.map((entry) => entry.endpoint), ['terminal/attach'])
  assert.equal(seen.streams[0]?.uplink, true, '不带上行就发不出命令')
})

test('远端报错且没给结果时，错误里带得上远端 code（不吞成「超时」）', async () => {
  const { rpc } = fakeRpc([{ type: 'snapshot', sequence: 1, screen: '' }], {
    failWith: { code: 'terminal/not-found', message: '没有这个终端' },
  })
  await assert.rejects(runSessionProbe({ rpc }, 'sess-1'), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /terminal\/not-found/)
    return true
  })
})
