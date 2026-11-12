import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { TeleportError } from '../errors.ts'
import type { SshTarget } from './config.ts'
import { buildProbeScript, parseProbeOutput, probeCommand, probeSshTarget, shellQuote } from './probe.ts'
import type { SshChild, SshSpawn } from './transport.ts'

const M = '__DSH_TELEPORT_PROBE__'
const DOLLAR_BRACE = String.fromCharCode(36) + '{'

const HOST_KEY = 'debug1: Server host key: ssh-ed25519 SHA256:8gvH0mq2xQ0mY0aQ0bFq3sZrKQ0mY0aQ0bFq3sZrKQ0\r\n'

function output(lines: readonly string[]): string {
  return lines.map((line) => M + line + '\r\n').join('')
}

const FULL = output([
  'platform=Linux',
  'arch=x86_64',
  'kernel=6.8.0-45-generic',
  'home=/home/hui',
  'node=v24.22.1',
  'dsh=0.2.1-rc.5',
  'dshhome=1',
  'end=1',
])

class FakeChild {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly #events = new EventEmitter()

  on(event: string, listener: (...args: never[]) => void): this {
    this.#events.on(event, listener as never)
    return this
  }

  kill(): boolean {
    return true
  }

  fire(event: string, ...args: unknown[]): void {
    this.#events.emit(event, ...args)
  }

  asChild(): SshChild {
    return this as unknown as SshChild
  }
}

interface Recorded {
  readonly args: string[][]
}

function spawnOf(options: {
  readonly stdout?: string
  readonly stderr?: string
  readonly code?: number
  readonly seen?: Recorded
}): SshSpawn {
  return (_executable, args) => {
    options.seen?.args.push([...args])
    const child = new FakeChild()
    setImmediate(() => {
      if (options.stdout !== undefined && options.stdout !== '') child.stdout.emit('data', Buffer.from(options.stdout))
      child.stderr.emit('data', Buffer.from(options.stderr ?? HOST_KEY))
      child.fire('exit', options.code ?? 0, null)
    })
    return child.asChild()
  }
}

function sandbox(): { readonly home: string; readonly keyFile: string; readonly cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'teleport-probe-'))
  const keyFile = join(home, 'id_ed25519')
  writeFileSync(
    keyFile,
    '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB\n-----END OPENSSH PRIVATE KEY-----\n',
    'utf8',
  )
  return { home, keyFile, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

function targetOf(keyFile: string): SshTarget {
  return {
    alias: 'syy',
    hostName: '198.51.100.8',
    user: 'hui',
    port: 22,
    identityFiles: [keyFile],
    proxyJump: [],
    source: { file: 'C:/Users/hui/.ssh/config', line: 20 },
  }
}

test('脚本只用 POSIX sh 内建，且以 end 标记收尾', () => {
  const script = buildProbeScript()
  assert.match(script, /uname -s/)
  assert.match(script, /uname -m/)
  assert.match(script, /uname -r/)
  assert.match(script, /command -v node/)
  assert.match(script, /\.dsh/)
  assert.ok(script.trimEnd().endsWith('p end 1'))
  assert.equal(script.includes(DOLLAR_BRACE), false, '不要用花括号变量展开这类需要二次转义的写法')
  assert.equal(script.includes('which '), false, 'which 不保证存在')
})

test('shellQuote 把单引号安全地送过远端 shell 的二次解析', () => {
  assert.equal(shellQuote("echo 'hi'"), "'echo '\\''hi'\\'''")
  assert.equal(shellQuote('plain'), "'plain'")
})

test('探测命令是 sh -c 加一个已转义的脚本参数', () => {
  const argv = probeCommand()
  assert.deepEqual(argv.slice(0, 2), ['sh', '-c'])
  assert.equal(argv.length, 3)
  assert.equal(argv[2]!.startsWith("'"), true)
  assert.equal(argv[2]!.endsWith("'"), true)
})

test('完整输出：七个字段全部解析，complete=true', () => {
  const parsed = parseProbeOutput(FULL)
  assert.equal(parsed.complete, true)
  assert.equal(parsed.missing.length, 0)
  assert.equal(parsed.conflicts.length, 0)
  assert.equal(parsed.values.platform, 'Linux')
  assert.equal(parsed.values.kernel, '6.8.0-45-generic')
  assert.equal(parsed.values.dshhome, '1')
})

test('横幅与杂行不影响解析（MOTD/.bashrc 会往 stdout 打东西）', () => {
  const noisy = ['Welcome to Ubuntu 24.04 LTS', 'Last login: Mon Nov 10 12:00:00 2025', FULL].join('\r\n')
  const parsed = parseProbeOutput(noisy)
  assert.equal(parsed.complete, true)
  assert.equal(parsed.values.arch, 'x86_64')
})

test('没有 end 标记：判不完整，而不是「字段缺失」', () => {
  const truncated = output(['platform=Linux', 'arch=x86_64'])
  const parsed = parseProbeOutput(truncated)
  assert.equal(parsed.complete, false)
  assert.deepEqual([...parsed.missing].sort(), ['dsh', 'dshhome', 'home', 'kernel', 'node'])
})

test('同一字段两个值：记进 conflicts（后到的仍取用）', () => {
  const parsed = parseProbeOutput(output(['kernel=6.8.0-45-generic', 'kernel=6.8.0-99-generic', 'end=1']))
  assert.deepEqual(parsed.conflicts, ['kernel'])
  assert.equal(parsed.values.kernel, '6.8.0-99-generic')
})

test('探针落到 BackendProbe：字段逐个到位，mirroredNetwork 不冒充 false', async () => {
  const { home, keyFile, cleanup } = sandbox()
  try {
    const result = await probeSshTarget({
      homeDir: home,
      target: targetOf(keyFile),
      auth: { kind: 'key' },
      spawn: spawnOf({ stdout: FULL }),
    })
    assert.equal(result.probe.kind, 'ssh')
    assert.equal(result.probe.target, 'hui@198.51.100.8')
    assert.equal(result.probe.home, '/home/hui')
    assert.equal(result.probe.nodeVersion, 'v24.22.1')
    assert.equal(result.probe.dshVersion, '0.2.1-rc.5')
    assert.equal(result.probe.hasDshHome, true)
    assert.equal(result.probe.mirroredNetwork, undefined)
    assert.deepEqual(result.system, { platform: 'Linux', arch: 'x86_64', kernel: '6.8.0-45-generic' })
    assert.equal(result.connect.hostKeyObserved, true)
  } finally {
    cleanup()
  }
})

test('远端没有 node/dsh：字段留空，不编造版本号', async () => {
  const { home, keyFile, cleanup } = sandbox()
  try {
    const bare = output(['platform=Linux', 'arch=aarch64', 'kernel=5.15.0', 'home=/root', 'node=', 'dsh=', 'dshhome=0', 'end=1'])
    const result = await probeSshTarget({
      homeDir: home,
      target: targetOf(keyFile),
      auth: { kind: 'key' },
      spawn: spawnOf({ stdout: bare }),
    })
    assert.equal(result.probe.nodeVersion, undefined)
    assert.equal(result.probe.dshVersion, undefined)
    assert.equal(result.probe.hasDshHome, false)
  } finally {
    cleanup()
  }
})

test('输出不完整：抛 probe-incomplete，文案带目标与下一步', async () => {
  const { home, keyFile, cleanup } = sandbox()
  try {
    await assert.rejects(
      probeSshTarget({
        homeDir: home,
        target: targetOf(keyFile),
        auth: { kind: 'key' },
        spawn: spawnOf({ stdout: output(['platform=Linux']) }),
      }),
      (error: unknown) => {
        assert.ok(error instanceof TeleportError)
        assert.equal(error.code, 'remote/probe-incomplete')
        assert.match(error.detail, /hui@192\.168\.5\.8/)
        assert.match(error.detail, /结束标记/)
        assert.ok(error.nextActions.length >= 2)
        return true
      },
    )
  } finally {
    cleanup()
  }
})

test('字段冲突同样拒绝：换机器/重放不能被静默吞掉', async () => {
  const { home, keyFile, cleanup } = sandbox()
  try {
    const conflicting = output(['platform=Linux', 'platform=FreeBSD', 'end=1'])
    await assert.rejects(
      probeSshTarget({
        homeDir: home,
        target: targetOf(keyFile),
        auth: { kind: 'key' },
        spawn: spawnOf({ stdout: conflicting }),
      }),
      (error: unknown) => error instanceof TeleportError && error.code === 'remote/probe-incomplete' && /platform/.test(error.detail),
    )
  } finally {
    cleanup()
  }
})

test('探测命令排在 -- 之后，远端的任何输出都不会被当成本地 ssh 选项', async () => {
  const { home, keyFile, cleanup } = sandbox()
  try {
    const seen: Recorded = { args: [] }
    await probeSshTarget({ homeDir: home, target: targetOf(keyFile), auth: { kind: 'key' }, spawn: spawnOf({ stdout: FULL, seen }) })
    const args = seen.args[0]!
    const dashDash = args.indexOf('--')
    assert.ok(dashDash > 0)
    assert.deepEqual(args.slice(dashDash + 1, dashDash + 3), ['sh', '-c'])
  } finally {
    cleanup()
  }
})
