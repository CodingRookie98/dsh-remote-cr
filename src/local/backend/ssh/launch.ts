/**
 * 启动远端 dsh 并把隧道拉起来：**一条 ssh 连接同时挂 `-L` 与 `-R`**（S5）。
 *
 * 为什么一条连接而不是三条：
 * - 认证只做一次（每次握手都是一次可能失败、可能触发 `MaxAuthTries` 的机会）；
 * - 生命周期绑在一起：连接断了，远端 dsh 与两条隧道一起没了，不会留下「半条命」的会话；
 * - 里程碑 M2 原文就是「同一连接挂 `-L` + `-R`」。
 *
 * 三条通路各自的方向（想清楚再改）：
 * 1. `-L 127.0.0.1:<本地端口>:127.0.0.1:<远端 dsh 端口>` —— GUI 在本地连隧道口，落到远端 dsh；
 * 2. `-R 127.0.0.1:0:127.0.0.1:<本地凭据代理端口>` —— 远端 agent 调模型时连它自己的 127.0.0.1，
 *    字节回流到本机代理（凭据不出本机）。端口用 `0` 让服务端分配，避免与远端既有服务撞车；
 * 3. stdin —— 唯一一条**从本地通向远端脚本**的控制通道，用来把 `-R` 分配到的端口号喂进去
 *    （端口号只有本地这侧才知道），并在回收时用 EOF 触发远端看门狗。
 *
 * 第 3 条是这个文件的关键设计：明知 `-R 0` 的端口要在连接建立后才由服务端分配，
 * 又必须在**同一条连接**里把它告诉远端进程，唯一的免费通道就是 stdin。远端脚本先
 * `read` 一行，再起 dsh，最后 `cat > /dev/null` 守着——宿主一关 stdin（或崩溃导致管道
 * 断开），`cat` 读到 EOF，脚本就把 dsh 杀掉。这与 WSL 侧看门狗是同一套语义，
 * 所以「只杀自己起的」这条铁律在两家实现里长得一样。
 *
 * 绝不静默降级：转发建不起来时 `ExitOnForwardFailure=yes` 会让 ssh 直接失败，
 * 而不是打个 warning 继续跑——否则远端拿不到代理，第一次推理才会神秘失败。
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

import { classifyStartFailure, parseDshEndpoint, tailLines } from '../dsh-output.ts'
import { TeleportError } from '../errors.ts'
import type { DshEndpoint, RemoteDshHandle } from '../handle.ts'
import type { SshTarget } from './config.ts'
import { knownHostsPath } from './known-hosts.ts'
import { shellQuote } from './probe.ts'
import { buildSshInvocation, type SshAuth, type SshConnectOptions } from './transport.ts'

/** 远端 agent 读这个变量取凭据代理地址；名字写进远端脚本，改它就是改契约。 */
export const PROXY_URL_ENV = 'TELEPORT_PROXY_URL'

/** 看门狗标记：回收是否干净靠它们从日志里判，不靠猜。 */
export const WATCHDOG_PID_MARK = 'TELEPORT_WATCHDOG_PID='
export const WATCHDOG_KILLED_MARK = 'TELEPORT_WATCHDOG_KILLED'

/** 关掉 stdin 之后给远端看门狗多久（含一次远端 kill + 连接拆除）。 */
const DISPOSE_GRACE_MS = 3_000

export interface SshLaunchStream {
  on(event: 'data', listener: (chunk: { toString(encoding?: string): string }) => void): unknown
  off?(event: 'data', listener: (chunk: { toString(encoding?: string): string }) => void): unknown
}

export interface SshLaunchChild {
  readonly stdin: { write(chunk: string): unknown; end(): unknown } | null
  readonly stdout: SshLaunchStream | null
  readonly stderr: SshLaunchStream | null
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
  kill(signal?: NodeJS.Signals | number): boolean
}

export type SshLaunchSpawn = (
  executable: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
) => SshLaunchChild

export interface SshLaunchOptions {
  readonly homeDir: string
  readonly target: SshTarget
  readonly auth: SshAuth
  /** 远端 dsh 检出目录（含 `apps/cli/lib/bin.js`）。 */
  readonly remoteRoot: string
  /** 远端 dsh 监听端口（只在远端回环上），默认 8899。 */
  readonly remotePort?: number
  /** 本地隧道口；不给就让内核挑一个空闲端口。 */
  readonly localPort?: number
  /** 本地凭据代理端口；给了才挂 `-R`。 */
  readonly proxyPort?: number
  readonly nodeCommand?: string
  readonly extraArgs?: readonly string[]
  /** 等访问 URL 的上限，默认 90s：SSH 握手 + 远端 dsh 冷启动比 WSL 更慢。 */
  readonly timeoutMs?: number
  readonly sshExecutable?: string
  readonly askpassPath?: string
  readonly connectTimeoutMs?: number
  readonly signal?: AbortSignal
  readonly spawn?: SshLaunchSpawn
}

export interface SshRemoteHandle extends RemoteDshHandle {
  readonly localPort: number
  readonly remotePort: number
  /** `-R` 实际分配到服务端的端口；没挂 `-R` 或没解析到就是 undefined。 */
  readonly remoteProxyPort: number | undefined
}

/**
 * 远端启动脚本。
 *
 * `< /dev/null` 必须加在后台命令上：不给的话 dsh 会和 `cat` 抢同一份 stdin，
 * 看门狗就读不到 EOF 了。这种抢管道的问题在真机上表现为「退出时远端不回收」，
 * 排查成本极高，所以这里显式切断。
 */
export function buildRemoteLaunchScript(options: {
  readonly remoteRoot: string
  readonly remotePort: number
  readonly host?: string
  readonly nodeCommand?: string
  readonly extraArgs?: readonly string[]
  readonly waitForProxyPort: boolean
}): string {
  const argv = [
    options.nodeCommand ?? 'node',
    'apps/cli/lib/bin.js',
    'web',
    '--no-open',
    '--port',
    String(options.remotePort),
    '--host',
    options.host ?? '127.0.0.1',
    ...(options.extraArgs ?? []),
  ]
  const lines: string[] = ['cd ' + shellQuote(options.remoteRoot) + ' || exit 1']
  if (options.waitForProxyPort) {
    lines.push('IFS= read -r _teleport_proxy_port || exit 1')
    lines.push('export ' + PROXY_URL_ENV + '="http://127.0.0.1:$_teleport_proxy_port"')
  }
  lines.push(argv.map((part) => shellQuote(part)).join(' ') + ' < /dev/null &')
  lines.push('_teleport_child=$!')
  lines.push("printf '%s%s\\n' " + JSON.stringify(WATCHDOG_PID_MARK) + ' "$_teleport_child"')
  lines.push('cat > /dev/null')
  lines.push('kill "$_teleport_child" 2>/dev/null')
  lines.push("printf '%s\\n' " + JSON.stringify(WATCHDOG_KILLED_MARK))
  return lines.join('\n')
}

export function localForwardSpec(localPort: number, remotePort: number): string {
  return '127.0.0.1:' + String(localPort) + ':127.0.0.1:' + String(remotePort)
}

/** `0` 作为远端监听端口 = 让服务端分配（OpenSSH 打印 `Allocated port`）。 */
export function remoteForwardSpec(localProxyPort: number): string {
  return '127.0.0.1:0:127.0.0.1:' + String(localProxyPort)
}

/** 从 ssh 的 verbose 里读回 `-R` 分到的端口。读不到就是 undefined，绝不猜。 */
export function parseAllocatedPort(logText: string): number | undefined {
  const match = /Allocated port (\d+) for remote forward/.exec(logText)
  if (match === null) return undefined
  const port = Number(match[1])
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined
}

/**
 * 隧道建不起来的两种典型死法，各自给可操作的话。
 *
 * 必须在 `classifyStartFailure` 之前判：那条分类器认的是 dsh 自己的启动话术，
 * 而转发失败发生在 dsh 还没被启动的时候（`ExitOnForwardFailure` 让 ssh 提前退出）。
 */
export function classifyTunnelFailure(logText: string): TeleportError | undefined {
  if (/remote port forwarding failed|forwarding failed for listen port|administratively prohibited/i.test(logText)) {
    return new TeleportError({
      code: 'remote/forward-unavailable',
      detail:
        '远端拒绝建立反向转发（凭据代理的回流通道），远端多半把 AllowTcpForwarding 关了：远端 agent 将拿不到本机代理。',
      nextActions: [
        '在远端 sshd_config 里开启 AllowTcpForwarding（或至少 permitlisten 127.0.0.1:*）后重连',
        '若服务端策略不可改，改用公司/内网已放行的跳板机',
        '临时绕行：让远端直连模型服务（凭据会离开本机，需人工确认）',
      ],
      logTail: tailLines(logText, 20),
    })
  }
  if (/bind: Address already in use|Cannot bind any address|Address already in use/i.test(logText)) {
    return new TeleportError({
      code: 'remote/startup-failed',
      detail: '隧道端口被占用（本地或远端其一），本次没有建立起可用的连接。',
      nextActions: ['重试（本地端口会重新挑一个）', '检查远端 dsh 端口是否被上一个没回收的进程占着'],
      logTail: tailLines(logText, 20),
    })
  }
  return undefined
}

/** 让内核挑一个空闲的本地端口；挑不到就报错，不退化成「用默认端口试试」。 */
export async function pickFreeLocalPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', (error) => {
      reject(
        new TeleportError({
          code: 'remote/startup-failed',
          detail: '没有可用的本地端口：' + error.message,
          nextActions: ['重试', '关闭占用大量端口的本地程序'],
        }),
      )
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => {
        if (port > 0) resolve(port)
        else
          reject(
            new TeleportError({
              code: 'remote/startup-failed',
              detail: '没有可用的本地端口（内核没有返回端口号）',
              nextActions: ['重试'],
            }),
          )
      })
    })
  })
}

/**
 * 启动远端 dsh，等到它打印带 token 的 URL 才 resolve；端点**改写成本地隧道口**。
 *
 * 改写是必须的：远端 dsh 说的是 `127.0.0.1:<remotePort>`，那个地址只在远端成立；
 * 本地这一侧要连的是 `127.0.0.1:<localPort>`。把远端原话交给 GUI 就会连不上。
 */
export async function launchSshDsh(options: SshLaunchOptions): Promise<SshRemoteHandle> {
  const remotePort = options.remotePort ?? 8899
  const localPort = options.localPort ?? (await pickFreeLocalPort())
  const proxyPort = options.proxyPort !== undefined && options.proxyPort > 0 ? options.proxyPort : undefined

  const script = buildRemoteLaunchScript({
    remoteRoot: options.remoteRoot,
    remotePort,
    waitForProxyPort: proxyPort !== undefined,
    ...(options.nodeCommand === undefined ? {} : { nodeCommand: options.nodeCommand }),
    ...(options.extraArgs === undefined ? {} : { extraArgs: options.extraArgs }),
  })

  const connectOptions: SshConnectOptions = {
    target: options.target,
    auth: options.auth,
    knownHostsFile: knownHostsPath(options.homeDir),
    forwardLocal: [localForwardSpec(localPort, remotePort)],
    exitOnForwardFailure: true,
    ...(proxyPort === undefined ? {} : { forwardRemote: [remoteForwardSpec(proxyPort)] }),
    ...(options.sshExecutable === undefined ? {} : { sshExecutable: options.sshExecutable }),
    ...(options.askpassPath === undefined ? {} : { askpassPath: options.askpassPath }),
    ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs }),
  }
  const invocation = buildSshInvocation(connectOptions, ['sh', '-c', shellQuote(script)])
  const spawnProcess = options.spawn ?? defaultSpawn
  const timeoutMs = options.timeoutMs ?? 90_000

  const child = spawnProcess(invocation.executable, invocation.args, invocation.env)
  let buffer = ''
  let remoteProxyPort: number | undefined
  let portSent = false
  let exited = false
  let killedMarkSeen = false
  let pidMarkSeen = false

  const digest = (chunk: { toString(encoding?: string): string }): void => {
    const text = chunk.toString('utf8')
    buffer += text
    if (text.includes(WATCHDOG_KILLED_MARK)) killedMarkSeen = true
    if (text.includes(WATCHDOG_PID_MARK)) pidMarkSeen = true
  }

  const endpoint = await new Promise<DshEndpoint>((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let detachAbort: (() => void) | undefined

    // 注意：这里**不摘** data 监听。摘了就再也收不到远端看门狗打出的 KILLED 标记与
    // 之后的输出，`log()` 会停在启动那一刻——而「回收干不干净」正需要启动之后的日志作证。
    const finish = (run: () => void): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      detachAbort?.()
      run()
    }

    const onData = (chunk: { toString(encoding?: string): string }): void => {
      digest(chunk)
      if (settled) return
      const found = parseDshEndpoint(buffer)
      if (found === undefined) return
      // 端点必须以本地隧道口为准：远端报的是它自己的 127.0.0.1:remotePort。
      finish(() => resolve({ host: '127.0.0.1', port: localPort, token: found.token }))
    }

    const onStderr = (chunk: { toString(encoding?: string): string }): void => {
      digest(chunk)
      if (settled) return
      if (portSent) return
      const allocated = parseAllocatedPort(buffer)
      if (allocated === undefined) return
      remoteProxyPort = allocated
      portSent = true
      // 把端口喂给远端脚本里那条 read —— 这是同一条连接内唯一的方向正确的通道。
      child.stdin?.write(String(allocated) + '\n')
    }

    const killChild = (): void => {
      try {
        child.kill()
      } catch {
        // 已经退了
      }
    }

    const onAbort = (): void => {
      killChild()
      finish(() =>
        reject(
          new TeleportError({
            code: 'remote/cancelled',
            detail: '用户取消了远端启动',
            nextActions: ['重试'],
            logTail: tailLines(buffer, 20),
          }),
        ),
      )
    }

    timer = setTimeout(() => {
      killChild()
      const tunnel = classifyTunnelFailure(buffer)
      finish(() => reject(tunnel ?? classifyStartFailure(buffer + '\nTIMEOUT after ' + String(timeoutMs) + 'ms')))
    }, timeoutMs)

    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        onAbort()
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true })
        detachAbort = () => options.signal?.removeEventListener('abort', onAbort)
      }
    }

    child.stdout?.on('data', onData)
    child.stderr?.on('data', onStderr)

    child.on('error', (error) => {
      finish(() =>
        reject(
          new TeleportError({
            code: 'remote/startup-failed',
            detail: '无法启动 ' + invocation.executable + '：' + error.message,
            nextActions: ['确认本机装有 OpenSSH 客户端', '检查 ssh 可执行文件路径'],
          }),
        ),
      )
    })

    child.on('exit', (code) => {
      exited = true
      const tunnel = classifyTunnelFailure(buffer)
      finish(() => reject(tunnel ?? classifyStartFailure(buffer + '\nssh exit ' + String(code ?? 'null'))))
    })
  })

  let disposed = false
  const handle: SshRemoteHandle = {
    endpoint,
    localPort,
    remotePort,
    // 用 getter 而不是快照：-R 的端口可能比访问 URL 晚一行到达，快照会把它丢掉。
    get remoteProxyPort(): number | undefined {
      return remoteProxyPort
    },
    log: () => buffer,
    dispose: async () => {
      if (disposed) return true
      disposed = true
      // 关 stdin ⇒ 远端 cat 读到 EOF ⇒ 脚本 kill 掉 dsh ⇒ ssh 退出。
      try {
        child.stdin?.end()
      } catch {
        // 管道已断
      }
      const clean = await new Promise<boolean>((resolve) => {
        if (exited) {
          resolve(true)
          return
        }
        const timer = setTimeout(() => {
          try {
            child.kill()
          } catch {
            // 已经退了
          }
          resolve(false)
        }, DISPOSE_GRACE_MS)
        child.on('exit', () => {
          clearTimeout(timer)
          resolve(true)
        })
      })
      // 干净 = ssh 退了 **且** 远端看门狗确实执行过 kill（两个标记都见到）。
      // 只见到 PID 却见不到 KILLED，说明远端子进程可能还活着，不能报 clean。
      return clean && (!pidMarkSeen || killedMarkSeen)
    },
  }
  return handle
}

const defaultSpawn: SshLaunchSpawn = (executable, args, env) =>
  spawn(executable, [...args], {
    env: { ...process.env, ...env },
    windowsHide: true,
    // stdin 必须是 pipe：既是端口喂给远端的通道，也是回收用的 EOF 信号。
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as unknown as SshLaunchChild
