import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { TeleportError } from '../errors.ts'
import type { SshTarget } from './config.ts'
import {
  buildRemoteLaunchScript,
  classifyTunnelFailure,
  launchSshDsh,
  localForwardSpec,
  parseAllocatedPort,
  remoteForwardSpec,
  WATCHDOG_KILLED_MARK,
  WATCHDOG_PID_MARK,
} from './launch.ts'
import type { SshLaunchChild, SshLaunchSpawn } from './launch.ts'

const URL_LINE = 'dsh web: http://127.0.0.1:8899/?token=nNGeh0uzerY0zDaNypBYG__fx61fjRoUVg8Wmj6XZU4\n'
const ALLOCATED = 'debug1: remote forward success for: listen 127.0.0.1:0, connect 127.0.0.1:9100\nAllocated port 41234 for remote forward to 127.0.0.1:9100\n'

const TARGET: SshTarget = {
  alias: 'syy',
  hostName: '198.51.100.8',
  user: 'hui',
  port: 22,
  identityFiles: [],
  proxyJump: [],
  source: { file: 'C:/Users/hui/.ssh/config', line: 20 },
}

class FakeLaunchChild {
  readonly stdinWrites: string[] = []
  readonly events = new EventEmitter()
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  ended = false
  killed = false
  /** end() 之后是否自动退出（模拟远端看门狗把 dsh 杀掉、ssh 收尾）。 */
  exitOnEnd = true

  readonly stdin = {
    write: (chunk: string): boolean => {
      this.stdinWrites.push(chunk)
      return true
    },
    end: (): void => {
      this.ended = true
      if (this.exitOnEnd) setImmediate(() => this.events.emit('exit', 0, null))
    },
  }

  on(event: string, listener: (...args: never[]) => void): this {
    this.events.on(event, listener as never)
    return this
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  asChild(): SshLaunchChild {
    return this as unknown as SshLaunchChild
  }
}

interface Script {
  readonly stderr: readonly string[]
  readonly stdout: readonly string[]
  readonly exitCode?: number
  readonly exitOnEnd?: boolean
}

function spawnOf(script: Script, seen?: { args: string[][] }): SshLaunchSpawn {
  return (_executable, args) => {
    seen?.args.push([...args])
    const child = new FakeLaunchChild()
    if (script.exitOnEnd === false) child.exitOnEnd = false
    setImmediate(() => {
      for (const chunk of script.stderr) child.stderr.emit('data', Buffer.from(chunk))
      for (const chunk of script.stdout) child.stdout.emit('data', Buffer.from(chunk))
      if (script.exitCode !== undefined) child.events.emit('exit', script.exitCode, null)
    })
    return child.asChild()
  }
}

const baseOptions = {
  homeDir: 'D:/Temp/teleport-home',
  target: TARGET,
  auth: { kind: 'agent' as const },
  remoteRoot: '/home/hui/workspace/tools/deepseek-harness',
  localPort: 31800,
}

test('远端脚本：不给 -R 时不 read 也不 export 代理地址', () => {
  const script = buildRemoteLaunchScript({ remoteRoot: '/srv/dsh', remotePort: 8899, waitForProxyPort: false })
  assert.equal(script.includes('IFS= read -r'), false)
  assert.equal(script.includes('TELEPORT_PROXY_URL'), false)
  assert.match(script, /cd '\/srv\/dsh' \|\| exit 1/)
})

test('远端脚本：给 -R 时先 read 端口再 export，并把 dsh 的 stdin 切到 /dev/null', () => {
  const script = buildRemoteLaunchScript({ remoteRoot: '/srv/dsh', remotePort: 8899, waitForProxyPort: true })
  const lines = script.split('\n')
  const readAt = lines.findIndex((line) => line.includes('IFS= read -r'))
  const exportAt = lines.findIndex((line) => line.includes('TELEPORT_PROXY_URL'))
  const spawnAt = lines.findIndex((line) => line.includes('apps/cli/lib/bin.js'))
  assert.ok(readAt >= 0 && exportAt > readAt && spawnAt > exportAt, 'read → export → 启动 dsh 的顺序不能变')
  assert.match(lines[spawnAt]!, /< \/dev\/null &$/, 'dsh 必须与看门狗分家，否则 cat 读不到 EOF')
})

test('远端脚本：看门狗标记的顺序是先 PID、后 cat、再 kill、最后 KILLED', () => {
  const script = buildRemoteLaunchScript({ remoteRoot: '/srv/dsh', remotePort: 8899, waitForProxyPort: false })
  const pidAt = script.indexOf(WATCHDOG_PID_MARK)
  const catAt = script.indexOf('cat > /dev/null')
  const killAt = script.indexOf('kill "$_teleport_child"')
  const killedAt = script.indexOf(WATCHDOG_KILLED_MARK)
  assert.ok(pidAt > 0 && catAt > pidAt && killAt > catAt && killedAt > killAt)
})

test('远端脚本：路径含空格时被正确转义', () => {
  const script = buildRemoteLaunchScript({ remoteRoot: '/srv/my dsh', remotePort: 8899, waitForProxyPort: false })
  assert.match(script, /cd '\/srv\/my dsh' \|\| exit 1/)
})

test('远端脚本：npm 装出来的 dsh 用绝对路径启动，且不切目录', () => {
  const script = buildRemoteLaunchScript({
    remoteRoot: '/home/hui/workspace/dsh',
    remotePort: 8899,
    waitForProxyPort: false,
    argvPrefix: ['/home/hui/.dsh-teleport/staging/abc/npm/bin/dsh'],
    cwd: null,
  })
  assert.ok(!script.includes('cd '), '包安装的 dsh 与 cwd 无关，切目录只会多一个失败点')
  assert.match(script, /'\/home\/hui\/\.dsh-teleport\/staging\/abc\/npm\/bin\/dsh' 'web' '--no-open'/)
  assert.ok(!script.includes('apps/cli/lib/bin.js'))
})

test('远端脚本：argvPrefix 缺省仍是检出形态（node + bin.js + cd）', () => {
  const script = buildRemoteLaunchScript({ remoteRoot: '/srv/dsh', remotePort: 8899, waitForProxyPort: false })
  assert.match(script, /^cd '\/srv\/dsh' \|\| exit 1/)
  assert.match(script, /'node' 'apps\/cli\/lib\/bin\.js' 'web'/)
})

test('转发规格：本地是固定端口，远端监听端口留 0 让服务端分配', () => {
  assert.equal(localForwardSpec(31800, 8899), '127.0.0.1:31800:127.0.0.1:8899')
  assert.equal(remoteForwardSpec(9100), '127.0.0.1:0:127.0.0.1:9100')
})

test('parseAllocatedPort 只认服务端那句 Allocated port，读不到就是 undefined', () => {
  assert.equal(parseAllocatedPort(ALLOCATED), 41234)
  assert.equal(parseAllocatedPort('debug1: remote forward success for: listen 127.0.0.1:0'), undefined)
  assert.equal(parseAllocatedPort(''), undefined)
})

test('classifyTunnelFailure：AllowTcpForwarding 关闭时给可操作错误', () => {
  const error = classifyTunnelFailure('Warning: remote port forwarding failed for listen port 0')
  assert.ok(error instanceof TeleportError)
  assert.equal(error.code, 'remote/forward-unavailable')
  assert.match(error.detail, /AllowTcpForwarding/)
  assert.ok(error.nextActions.length >= 2)
})

test('classifyTunnelFailure：端口占用归到 startup-failed，干净日志返回 undefined', () => {
  const busy = classifyTunnelFailure('bind [127.0.0.1]:31800: Address already in use')
  assert.equal(busy?.code, 'remote/startup-failed')
  assert.equal(classifyTunnelFailure('debug1: Authentication succeeded'), undefined)
})

test('-L 与 -R 落在同一条连接上，且转发失败必须让 ssh 直接退出', async () => {
  const seen = { args: [] as string[][] }
  await launchSshDsh({
    ...baseOptions,
    proxyPort: 9100,
    spawn: spawnOf({ stderr: [ALLOCATED], stdout: [URL_LINE] }, seen),
  })
  const args = seen.args[0]!
  assert.ok(args.includes('-L') && args.includes('-R'), '两个转发都要挂上')
  assert.equal(args[args.indexOf('-L') + 1], '127.0.0.1:31800:127.0.0.1:8899')
  assert.equal(args[args.indexOf('-R') + 1], '127.0.0.1:0:127.0.0.1:9100')
  assert.ok(args.includes('ExitOnForwardFailure=yes'), '转发失败不能静默继续')
})

test('端点改写成本地隧道口，token 原样保留', async () => {
  const handle = await launchSshDsh({ ...baseOptions, spawn: spawnOf({ stderr: [''], stdout: [URL_LINE] }) })
  assert.equal(handle.endpoint.host, '127.0.0.1')
  assert.equal(handle.endpoint.port, 31800, 'GUI 连的是本地隧道口，不是致远端的 8899')
  assert.equal(handle.endpoint.token, 'nNGeh0uzerY0zDaNypBYG__fx61fjRoUVg8Wmj6XZU4')
  assert.equal(handle.localPort, 31800)
  assert.equal(handle.remotePort, 8899)
  await handle.dispose()
})

test('-R 分配到的端口经 stdin 喂给远端脚本（同一条连接唯一的正向通道）', async () => {
  let child: FakeLaunchChild | undefined
  const spawn: SshLaunchSpawn = () => {
    child = new FakeLaunchChild()
    setImmediate(() => {
      child!.stderr.emit('data', Buffer.from(ALLOCATED))
      child!.stdout.emit('data', Buffer.from(URL_LINE))
    })
    return child.asChild()
  }
  const handle = await launchSshDsh({ ...baseOptions, proxyPort: 9100, spawn })
  assert.deepEqual(child!.stdinWrites, ['41234\n'])
  assert.equal(handle.remoteProxyPort, 41234)
  await handle.dispose()
})

test('没挂 -R：不传 -R、不写 stdin', async () => {
  const seen = { args: [] as string[][] }
  let child: FakeLaunchChild | undefined
  const spawn: SshLaunchSpawn = (_executable, args) => {
    seen.args.push([...args])
    child = new FakeLaunchChild()
    setImmediate(() => child!.stdout.emit('data', Buffer.from(URL_LINE)))
    return child.asChild()
  }
  const handle = await launchSshDsh({ ...baseOptions, spawn })
  assert.equal(seen.args[0]!.includes('-R'), false)
  assert.deepEqual(child!.stdinWrites, [])
  assert.equal(handle.remoteProxyPort, undefined)
  await handle.dispose()
})

test('dispose 关 stdin 让远端看门狗回收；两个标记都在才算干净', async () => {
  const withMarks: Script = {
    stderr: [WATCHDOG_PID_MARK + '4242\n', ''],
    stdout: [URL_LINE, WATCHDOG_KILLED_MARK + '\n'],
  }
  const handle = await launchSshDsh({ ...baseOptions, spawn: spawnOf(withMarks) })
  const clean = await handle.dispose()
  assert.equal(clean, true)
})

test('只见 PID 不见 KILLED：不报干净（远端可能还有幸存进程）', async () => {
  const handle = await launchSshDsh({
    ...baseOptions,
    spawn: spawnOf({ stderr: [WATCHDOG_PID_MARK + '4242\n', ''], stdout: [URL_LINE] }),
  })
  const clean = await handle.dispose()
  assert.equal(clean, false, '没有 KILLED 证据就不能声称回收干净')
})

test('等不到 URL 就超时：报 startup-failed 并带日志尾', async () => {
  await assert.rejects(
    launchSshDsh({
      ...baseOptions,
      timeoutMs: 60,
      spawn: spawnOf({ stderr: [''], stdout: ['dsh web: prompting for the initial launch token\n'] }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof TeleportError)
      assert.equal(error.code, 'remote/startup-failed')
      assert.ok(error.logTail !== undefined)
      return true
    },
  )
})

test('ssh 因转发被拒提前退出：报 forward-unavailable，而不是笼统的启动失败', async () => {
  await assert.rejects(
    launchSshDsh({
      ...baseOptions,
      proxyPort: 9100,
      spawn: spawnOf({ stderr: ['Warning: remote port forwarding failed for listen port 0\n'], stdout: [], exitCode: 255 }),
    }),
    (error: unknown) => error instanceof TeleportError && error.code === 'remote/forward-unavailable',
  )
})

test('取消信号：立刻拒绝并 kill，报 remote/cancelled', async () => {
  const controller = new AbortController()
  const spawn: SshLaunchSpawn = () => {
    const child = new FakeLaunchChild()
    child.exitOnEnd = false
    setImmediate(() => controller.abort())
    return child.asChild()
  }
  await assert.rejects(
    launchSshDsh({ ...baseOptions, signal: controller.signal, spawn }),
    (error: unknown) => error instanceof TeleportError && error.code === 'remote/cancelled',
  )
})

test('不传 localPort 时由内核挑一个空闲端口，且与远端端口不同', async () => {
  const { localPort: _ignoredPort, ...withoutLocalPort } = baseOptions
  const handle = await launchSshDsh({
    ...withoutLocalPort,
    spawn: spawnOf({ stderr: [''], stdout: [URL_LINE] }),
  })
  assert.ok(handle.localPort > 0)
  assert.notEqual(handle.localPort, handle.remotePort)
  assert.equal(handle.endpoint.port, handle.localPort)
  await handle.dispose()
})
