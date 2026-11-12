import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { TeleportError } from '../errors.ts'
import type { SshTarget } from './config.ts'
import {
  SECRET_ENV,
  type SshChild,
  type SshSpawn,
  askpassScript,
  buildSshInvocation,
  connectSsh,
  describeTarget,
  runSsh,
} from './transport.ts'

const TARGET: SshTarget = {
  alias: 'syy',
  hostName: '198.51.100.8',
  user: 'hui',
  port: 22,
  identityFiles: ['C:/Users/hui/.ssh/id_ed25519'],
  proxyJump: [],
  source: { file: 'C:/Users/hui/.ssh/config', line: 20 },
}

const ASKPASS = 'C:/Users/hui/.dsh-teleport/askpass.cjs'

function argsOf(target: SshTarget = TARGET, extra: Partial<Parameters<typeof buildSshInvocation>[0]> = {}): string[] {
  return [...buildSshInvocation({ target, auth: { kind: 'key' }, ...extra }).args]
}

/** 断言 argv 里不出现机密：Windows 上别的进程能读 argv，口令进 argv 就是公开。 */
function assertNoSecret(args: readonly string[], secret: string): void {
  const joined = args.join(' ')
  assert.equal(joined.includes(secret), false, 'argv 里出现了机密：' + joined)
}

test('私钥认证：IdentitiesOnly + 每个 -i，且不需要 askpass', () => {
  const invocation = buildSshInvocation({ target: TARGET, auth: { kind: 'key' } })
  const args = [...invocation.args]
  assert.ok(args.includes('IdentitiesOnly=yes'))
  assert.ok(args.includes('-i'))
  assert.equal(args[args.indexOf('-i') + 1], 'C:/Users/hui/.ssh/id_ed25519')
  assert.ok(args.includes('BatchMode=yes'), '没有机密的连接不该等交互输入')
  assert.ok(args.includes('PreferredAuthentications=publickey'))
  assert.equal(invocation.needsAskpass, false)
  assert.deepEqual({ ...invocation.env }, {})
})

test('私钥认证：多个 IdentityFile 按顺序全部带上', () => {
  const target: SshTarget = { ...TARGET, identityFiles: ['C:/a', 'C:/b'] }
  const args = argsOf(target)
  const indexes = args.flatMap((value, index) => (value === '-i' ? [index] : []))
  assert.deepEqual(
    indexes.map((index) => args[index + 1]),
    ['C:/a', 'C:/b'],
  )
})

test('密码认证：显式禁用公钥与隐式 agent（否则 MaxAuthTries 会被吃光）', () => {
  const invocation = buildSshInvocation({
    target: TARGET,
    auth: { kind: 'password', password: 'hunter2-secret' },
    askpassPath: ASKPASS,
  })
  const args = [...invocation.args]
  assert.ok(args.includes('PubkeyAuthentication=no'))
  assert.ok(args.includes('IdentitiesOnly=yes'))
  assert.ok(args.includes('PreferredAuthentications=password,keyboard-interactive'))
  assert.ok(args.includes('BatchMode=no'))
  assert.ok(args.includes('NumberOfPasswordPrompts=1'))
  assertNoSecret(args, 'hunter2-secret')
  assert.equal(invocation.needsAskpass, true)
  assert.equal(invocation.env[SECRET_ENV], 'hunter2-secret')
  assert.equal(invocation.env['SSH_ASKPASS'], ASKPASS)
  assert.equal(invocation.env['SSH_ASKPASS_REQUIRE'], 'force')
})

test('agent 认证：不能加 IdentitiesOnly（那会把 agent 的钥匙全部屏蔽）', () => {
  const args = argsOf(TARGET, { auth: { kind: 'agent' } })
  assert.equal(args.includes('IdentitiesOnly=yes'), false)
  assert.ok(args.includes('PubkeyAuthentication=yes'))
  assert.ok(args.includes('BatchMode=yes'))
})

test('加密私钥的口令：走 askpass，同样不进 argv', () => {
  const invocation = buildSshInvocation({
    target: TARGET,
    auth: { kind: 'key', passphrase: 'pass-phrase-xyz' },
    askpassPath: ASKPASS,
  })
  assert.equal(invocation.needsAskpass, true)
  assert.ok([...invocation.args].includes('BatchMode=no'))
  assertNoSecret(invocation.args, 'pass-phrase-xyz')
  assert.equal(invocation.env[SECRET_ENV], 'pass-phrase-xyz')
})

test('口令认证缺 askpassPath：当场报错，不静默降级成「没有口令」', () => {
  assert.throws(
    () => buildSshInvocation({ target: TARGET, auth: { kind: 'password', password: 'x' } }),
    (error: unknown) => error instanceof TeleportError && /askpass/.test(error.detail),
  )
})

test('端口与用户名：22 不带 -p，非 22 带；没写 User 就不带 -l', () => {
  assert.equal(argsOf(TARGET).includes('-p'), false)
  const custom = argsOf({ ...TARGET, port: 2222, user: undefined })
  assert.equal(custom[custom.indexOf('-p') + 1], '2222')
  assert.equal(custom.includes('-l'), false)

  const named = argsOf({ ...TARGET, user: 'root' })
  assert.equal(named[named.indexOf('-l') + 1], 'root')
})

test('跳板链按 OpenSSH 语法拼 -J，缺省端口不写冒号', () => {
  const target: SshTarget = {
    ...TARGET,
    hostName: '10.0.0.9',
    proxyJump: [
      { host: '198.51.100.8', user: 'hui', port: 22 },
      { host: '203.0.113.70', user: undefined, port: 2222 },
    ],
  }
  const args = argsOf(target)
  assert.equal(args[args.indexOf('-J') + 1], 'hui@198.51.100.8,203.0.113.70:2222')
})

test('远端命令必须落在 -- 之后：否则会被 ssh 当成自己的选项', () => {
  const args = [...buildSshInvocation({ target: TARGET, auth: { kind: 'key' } }, ['-oProxyCommand=evil', 'true']).args]
  const marker = args.indexOf('--')
  assert.ok(marker > 0)
  assert.equal(args.indexOf('198.51.100.8'), marker - 1, '目标必须紧挨着 -- 前面')
  assert.deepEqual(args.slice(marker + 1), ['-oProxyCommand=evil', 'true'])
})

test('known_hosts 用私有库；不传则交给上层（绝不默认写用户的 ~/.ssh/known_hosts）', () => {
  assert.equal(argsOf().some((value) => value.startsWith('UserKnownHostsFile=')), false)
  const withFile = argsOf(TARGET, { knownHostsFile: 'C:/Users/hui/.dsh-teleport/known_hosts' })
  assert.ok(withFile.includes('UserKnownHostsFile=C:/Users/hui/.dsh-teleport/known_hosts'))
  assert.ok(withFile.includes('StrictHostKeyChecking=accept-new'))
  assert.ok(withFile.includes('LogLevel=VERBOSE'), 'TOFU 要靠 VERBOSE 抓 Server host key 行')
})

test('askpass 脚本本身不含机密，只透传环境变量', () => {
  const script = askpassScript()
  assert.match(script, new RegExp('process\\.env'))
  assert.match(script, new RegExp(SECRET_ENV))
  assert.equal(/hunter2|password\s*=\s*['"]/.test(script), false)
  // 不能有 shebang 依赖：Windows 上执行的是 node 而不是脚本解释器
  assert.equal(script.startsWith('#!'), false)
})

test('describeTarget 只在非 22 端口时带端口', () => {
  assert.equal(describeTarget(TARGET), 'hui@198.51.100.8')
  assert.equal(describeTarget({ ...TARGET, port: 2222 }), 'hui@198.51.100.8:2222')
  assert.equal(describeTarget({ ...TARGET, user: undefined }), '198.51.100.8')
})

/** 假 ssh 子进程：只发真实 ssh 也会发的那几种事件。 */
class FakeChild {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly kills: string[] = []
  readonly #events = new EventEmitter()

  on(event: string, listener: (...args: never[]) => void): this {
    this.#events.on(event, listener as never)
    return this
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(String(signal ?? 'SIGTERM'))
    return true
  }

  fire(event: string, ...args: unknown[]): void {
    this.#events.emit(event, ...args)
  }

  asChild(): SshChild {
    return this as unknown as SshChild
  }
}

const baseOptions = { target: TARGET, auth: { kind: 'key' } as const, deadlineMs: 5_000 }

test('runSsh 成功时收集 stdout 并返回 0', async () => {
  const child = new FakeChild()
  const spawn: SshSpawn = () => {
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('uname-out\n'))
      child.stderr.emit('data', Buffer.from('debug1: Reading configuration data\n'))
      child.fire('exit', 0, null)
    })
    return child.asChild()
  }
  const result = await runSsh({ ...baseOptions, command: ['uname', '-a'], spawn })
  assert.equal(result.code, 0)
  assert.equal(result.stdout, 'uname-out\n')
  assert.match(result.stderr, /Reading configuration data/)
})

test('runSsh 非零退出：变成结构化错误，日志尾可复制', async () => {
  const child = new FakeChild()
  const spawn: SshSpawn = () => {
    setImmediate(() => {
      child.stderr.emit('data', Buffer.from('hui@198.51.100.8: Permission denied (publickey).\r\n'))
      child.fire('exit', 255, null)
    })
    return child.asChild()
  }
  await assert.rejects(
    runSsh({ ...baseOptions, spawn }),
    (error: unknown) => {
      assert.ok(error instanceof TeleportError)
      assert.equal(error.code, 'remote/auth-failed')
      assert.match(error.logTail, /Permission denied/)
      assert.ok(error.nextActions.length > 0)
      return true
    },
  )
})

test('找不到 ssh.exe：报 ssh-missing，而不是「连接失败」', async () => {
  const child = new FakeChild()
  const spawn: SshSpawn = () => {
    setImmediate(() => child.fire('error', Object.assign(new Error('spawn ssh.exe ENOENT'), { code: 'ENOENT' })))
    return child.asChild()
  }
  await assert.rejects(
    runSsh({ ...baseOptions, spawn }),
    (error: unknown) => error instanceof TeleportError && error.code === 'remote/ssh-missing',
  )
})

test('超时立刻 kill 并报超时；之后迟到的 exit 不能把根因盖掉', async () => {
  const child = new FakeChild()
  let settles = 0
  const spawn: SshSpawn = () => child.asChild()
  const promise = runSsh({ ...baseOptions, deadlineMs: 30, spawn })
  promise.then(
    () => {
      settles += 1
    },
    () => {
      settles += 1
    },
  )
  const error = await promise.then(
    () => assert.fail('不该成功'),
    (reason: unknown) => reason,
  )
  assert.ok(error instanceof TeleportError)
  assert.equal(error.code, 'remote/auth-timeout')
  assert.deepEqual(child.kills, ['SIGTERM'])

  // 杀进程后 ssh 还会吐 exit / error：没有 settled 闸门就会在这里二次抛（未捕获拒绝）
  child.fire('exit', 0, null)
  child.fire('error', new Error('late error'))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(settles, 1, 'Promise 只能 settle 一次')
})

test('取消：kill 并报 cancelled，exit 之后不再结算', async () => {
  const child = new FakeChild()
  const controller = new AbortController()
  const spawn: SshSpawn = () => child.asChild()
  const promise = runSsh({ ...baseOptions, deadlineMs: 10_000, signal: controller.signal, spawn })
  setTimeout(() => controller.abort(), 10)
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof TeleportError && error.code === 'remote/cancelled',
  )
  assert.deepEqual(child.kills, ['SIGTERM'])
  child.fire('exit', 0, null)
})

test('connectSsh 只跑 true：不做任何有副作用的远端动作', async () => {
  const child = new FakeChild()
  let seen: readonly string[] = []
  const spawn: SshSpawn = (_executable, args) => {
    seen = args
    setImmediate(() => child.fire('exit', 0, null))
    return child.asChild()
  }
  await connectSsh({ ...baseOptions, spawn })
  assert.deepEqual(seen.slice(seen.indexOf('--') + 1), ['true'])
})

test('远端命令默认就是 true（不做无副作用之外的假设）', async () => {
  const child = new FakeChild()
  let seen: readonly string[] = []
  const spawn: SshSpawn = (_executable, args) => {
    seen = args
    setImmediate(() => child.fire('exit', 0, null))
    return child.asChild()
  }
  await runSsh({ ...baseOptions, spawn })
  assert.deepEqual(seen.slice(seen.indexOf('--') + 1), ['true'])
})
