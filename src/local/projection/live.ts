/**
 * 真机实现：把「连到一台远端」接成 `ProjectionService` 需要的那一个函数。
 *
 * 顺序不能换：
 * 1. 起远端 `dsh web` 并从日志里取 `token`；
 * 2. `RemoteRpc.open` 用 `token` 换 v2 签名 Cookie 并建 RPC 驱动。
 *
 * 两条后端各走各的启动器，**共用同一段收尾**（`openConnection`）：
 * - WSL：`launchRemoteDsh`（`wsl.exe --exec`，真机 9–18s）；
 * - SSH：`launchSshDsh`（`ssh -L` 隧道 + 远端看门狗，真机 66s 冷启动 / 16s 热）；
 * 两边的 `handle.endpoint` 都已是**本地可连**的 `{host, port, token}`（SSH 的端口是
 * 本地隧道口，不是远端的 8899），所以握手代码不需要知道后端是谁。
 *
 * 为什么 launch 与 handshake 必须成对：token 只出现在**这一次启动的日志**里
 * （`parseDshEndpoint`）。拿着上一次的 token 去握手只会得 401，所以这里不接受
 * 外部传入的 token —— 连接的所有权必须和进程的所有权在一起。
 *
 * **进程与传输是分开释放的**（P3.5.2 实测后改）：
 * - `rehandshake()` 只换传输，进程留着 —— 真机实测 5ms；
 * - `dispose()` 连进程一起收 —— 重新起进程要 9.2s（WSL）/ 66s（SSH 冷启动）。
 * 断线时先试前者：远端没死就白拿一段冷启动。绝不能反过来（先重启再判断），那等于
 * 每次抖动都让用户等一次冷启动。
 *
 * 释放时**先放 RPC 再收进程**：反过来会让还活着的 WS 撞上一个已经消失的宿主，
 * 日志里出现一堆无意义的 ECONNRESET。
 */

import { join } from 'node:path'
import { TeleportError, type ConnectionPhase } from '../backend/errors.ts'
import type { RemoteDshHandle } from '../backend/handle.ts'
import { type SshTarget, readSshConfig, resolveSshTarget } from '../backend/ssh/config.ts'
import { launchSshDsh } from '../backend/ssh/launch.ts'
import { resolveRemoteDsh, type RemoteDshRuntime, type ResolveRemoteDshRequest } from '../backend/ssh/runtime.ts'
import type { SshAuth } from '../backend/ssh/transport.ts'
import { launchRemoteDsh } from '../backend/wsl/launch.ts'
import { runInDistro } from '../backend/wsl/exec.ts'
import { planEnvInjection, resolveEnvPolicy, type EnvPolicy } from '../env-policy/index.ts'
import type { AttachControl, ConnectTarget, RemoteConnection, SshConnectTarget } from './service.ts'
import { RemoteRpc } from './remote.ts'

/** SSH 后端需要的宿主侧材料；不给就明确报错，不猜默认值。 */
export interface LiveSshOptions {
  /** 本地 home：`~/.ssh/config` 与 `.dsh-teleport/`（known_hosts、anchors）都挂在这里。 */
  readonly homeDir: string
  /**
   * 按别名解析认证方式。
   *
   * 为什么是回调而不是字段：口令/私钥口令只在**真的要连**的时候才该出现，
   * 而且要能走系统的凭据存储（`git credential` / Windows Credential Manager），
   * 那些来源是异步且可能弹窗的。这里只要求「给我一台目标的认证方式」。
   */
  readonly authFor: (target: SshTarget) => SshAuth | Promise<SshAuth>
  /** 覆盖 `~/.ssh/config` 的位置（探针与多份配置的测试用）。 */
  readonly configFile?: string
  readonly sshExecutable?: string
  readonly connectTimeoutMs?: number
  /**
   * 本机凭据代理端口：给了就在 `ssh` 上加 `-R 127.0.0.1:0:127.0.0.1:<port>`。
   *
   * 为什么是可选：代理起不来（没有凭据文件、端口被占）不该让整个远端连不上 ——
   * 那种情况下用户仍能连远端、只是模型请求不走代理。但**失败要响**：代理起不来时
   * 入口会记一条日志，而不是静默当成没配。
   */
  readonly proxyPort?: number | (() => number | undefined)
  /**
   * 追加给远端 dsh 进程的环境变量（值里可用 `$TELEPORT_PROXY_URL`）。
   *
   * 为什么入口要能传：远端 provider 的 `baseURL`/key 只能靠环境变量在启动时指定，
   * 而代理的远端端口是转发建好之后才分配 —— 调用方在启动前不知道它，
   * 所以这里只传「怎么引用」，展开交给 `buildRemoteLaunchScript`。
   */
  readonly extraEnv?: Readonly<Record<string, string>>
  /** 装哪个版本的 dsh（只有走到引导器时用得上）。 */
  readonly dshVersion?: string
  /**
   * 「远端 dsh 用哪一份」的注入缝：缺省走 `resolveRemoteDsh`（检出优先，否则引导器装 staging）。
   *
   * 留这个缝不是为了测试方便而已：真机上「远端有没有检出」是环境事实，
   * 而这里要能在没有 SSH 的机器上被完整单测。
   */
  readonly resolveDsh?: (request: ResolveRemoteDshRequest) => Promise<RemoteDshRuntime>
}

export interface LiveConnectOptions {
  /** `wsl.exe` 可执行文件名或绝对路径。 */
  readonly executable?: string
  /** 起远端 dsh 的超时，默认 60s（WSL 真机实测 9–18s）。 */
  readonly launchTimeoutMs?: number
  /** SSH 后端材料；没配就只支持 WSL 目标（点 SSH 会得到结构化错误）。 */
  readonly ssh?: LiveSshOptions
  /**
   * 环境档位（`reuse` / `isolated` / `sync`）。缺省 `reuse`。
   *
   * 收**原始字符串**而不是解析后的值：档位来自配置/环境变量，写错时必须让用户
   * 在「点连接」那一刻看到结构化错误，而不是插件加载时就崩掉、连面板都开不出来。
   */
  readonly envPolicy?: string | undefined
}

/**
 * 造一个「给定 target 就连上去」的函数。
 *
 * 返回的函数**每次都真的起一个远端进程**：`ProjectionService` 已经保证同一 target
 * 不重复调用它，所以这里不需要自己做缓存。断线重连优先走 `rehandshake()`，
 * 只有进程真的没了才会再进这里。
 */
export function createLiveConnect(
  options: LiveConnectOptions = {},
): (target: ConnectTarget, control?: AttachControl) => Promise<RemoteConnection> {
  return async (target, control) => {
    const signal = control?.signal
    const onPhase = control?.onPhase
    if (target.backend === 'ssh') return connectSsh(target, options, { signal, onPhase })
    return connectWsl(target, options, { signal, onPhase })
  }
}

/**
 * WSL：起远端 dsh，按环境档位决定要不要注入 `DSH_HOME`。
 *
 * 隔离档必须**先问远端自己的 `$HOME`**：`wsl.exe` 里的 `$HOME` 与 Windows 侧的
 * `userprofile` 不是一回事（可能是 `/home/hui`，也可能不是），猜错就会把 dsh
 * 装到/读到不存在的地方——而且还能「成功」跑起来，只是用的是别处的环境。
 */
/** 连接层收到的控制面：取消信号 + 阶段回调（`ProjectionService.attach` 传下来的）。 */
interface LiveControl {
  readonly signal?: AbortSignal | undefined
  readonly onPhase?: ((phase: ConnectionPhase) => void) | undefined
}

/**
 * 取消要落到**正在进行的那一步**上，而不是只在结束后回一句「已取消」。
 * 阶段之间各查一次：`launchSshDsh` 自己认 `signal`，但前面的远端检查不认，
 * 那里只能靠边界检查尽早退出。
 */
function abortIfCancelled(signal?: AbortSignal): void {
  if (signal === undefined || !signal.aborted) return
  throw new TeleportError({
    code: 'remote/cancelled',
    detail: '已取消这次接入',
    nextActions: ['重新点一次「接入」', '换个目标再试'],
  })
}
async function connectWsl(
  target: ConnectTarget & { readonly backend: 'wsl' },
  options: LiveConnectOptions,
  control: LiveControl,
): Promise<RemoteConnection> {
  const policy = resolvePolicy(options.envPolicy)
  control.onPhase?.('probe')
  const home = policy === 'isolated' ? await wslHome(options.executable, target.distro) : ''
  abortIfCancelled(control.signal)
  const injection = planEnvInjection(policy, { home, hostKey: 'wsl:' + target.distro })
  control.onPhase?.('launch')
  const handle = await launchRemoteDsh({
    ...(options.executable === undefined ? {} : { executable: options.executable }),
    distro: target.distro,
    remoteRoot: target.remoteRoot,
    port: target.port,
    ...(options.launchTimeoutMs === undefined ? {} : { timeoutMs: options.launchTimeoutMs }),
    ...(injection.env === undefined ? {} : { env: injection.env }),
    ...(control.signal === undefined ? {} : { signal: control.signal }),
  })
  control.onPhase?.('tunnel')
  return openConnection(handle, policy)
}

/** 档位字符串 → 枚举；写错时给结构化错误，不静默回落到 `reuse`。 */
function resolvePolicy(raw: string | undefined): EnvPolicy {
  try {
    return resolveEnvPolicy(raw)
  } catch (error) {
    throw new TeleportError({
      code: 'remote/env-policy-invalid',
      detail: error instanceof Error ? error.message : String(error),
      nextActions: ['把环境档位改成 reuse 或 isolated', '清空该配置即回到默认档 reuse'],
      cause: error,
    })
  }
}

/** 隔离档要拼远端 home；拿不到就停在这里，不猜一个「大概是 /home/xxx」。 */
async function wslHome(executable: string | undefined, distro: string): Promise<string> {
  const result = await runInDistro(executable ?? 'wsl.exe', distro, ['sh', '-c', 'printf %s "$HOME"'])
  const home = result.stdoutText.trim()
  if (result.exitCode !== 0 || home === '') {
    throw new TeleportError({
      code: 'remote/probe-incomplete',
      detail: '读不到 WSL 发行版 ' + distro + ' 的 $HOME（退出码 ' + String(result.exitCode) + '，stderr ' + result.stderrText.trim().slice(-200) + '）',
      nextActions: ['确认该发行版里有 sh', '改用 reuse 档，或改连 SSH 目标'],
    })
  }
  return home
}

/**
 * SSH：按别名解析出真实目标，起 `ssh -L` 隧道与远端 dsh，再握手。
 *
 * 为什么别名要在这里解析而不是更早：`ConnectTarget` 会进 `/snapshot` 的 HTTP 响应，
 * 里面**不能**有主机名、用户名、私钥路径（铁律 3「凭据不出本机」）。别名是用户自己
 * 起的名，不含身份信息；真目标只在这一层存在。
 */
async function connectSsh(
  target: SshConnectTarget,
  options: LiveConnectOptions,
  control: LiveControl,
): Promise<RemoteConnection> {
  const ssh = options.ssh
  abortIfCancelled(control.signal)
  if (ssh === undefined) {
    throw new TeleportError({
      code: 'remote/ssh-target-unresolved',
      detail: `宿主没有配置 SSH 后端（本地 home 与认证解析），无法连 ${target.alias}`,
      nextActions: ['在宿主配置里填 SSH 后端参数', '改连 WSL 目标', '查看 docs/architecture.md 的 SSH 一节'],
    })
  }

  const file = ssh.configFile ?? join(ssh.homeDir, '.ssh', 'config')
  let config: ReturnType<typeof readSshConfig>
  try {
    config = readSshConfig({ file, homeDir: ssh.homeDir })
  } catch (error) {
    throw new TeleportError({
      code: 'remote/ssh-target-unresolved',
      detail: `读不到 SSH 配置 ${file}：${error instanceof Error ? error.message : String(error)}`,
      nextActions: ['检查该文件是否存在且有读权限', '在宿主配置里指定 configFile'],
      cause: error,
    })
  }

  const resolved = resolveSshTarget(config.parsed, target.alias, { homeDir: ssh.homeDir, file })
  if (resolved.target === undefined) {
    throw new TeleportError({
      code: 'remote/ssh-target-unresolved',
      detail: `${file} 里没有 Host ${target.alias}`,
      nextActions: ['在 ~/.ssh/config 里加一个 Host 段', '改选已有的别名'],
    })
  }
  // 配置问题一律先报：`identity-is-public-key` 这种，连上去也只会得到 permission denied。
  const problem = resolved.problems[0] ?? config.problems[0]
  if (problem !== undefined) {
    throw new TeleportError({
      code: 'remote/ssh-target-unresolved',
      detail: `${problem.file}:${String(problem.line)} ${problem.message}`,
      nextActions: ['按提示改这一行', '改选其他别名'],
    })
  }

  const auth = await ssh.authFor(resolved.target)
  // 先决定「用远端检出还是引导器装的那份」：一台普通 SSH 目标通常**没有** dsh 检出，
  // 缺省启动前缀（`node apps/cli/lib/bin.js`）会让接入在启动那步失败。
  const runtime = await (ssh.resolveDsh ?? resolveRemoteDsh)({
    homeDir: ssh.homeDir,
    target: resolved.target,
    auth,
    remoteRoot: target.remoteRoot,
    ...(ssh.dshVersion === undefined ? {} : { dshVersion: ssh.dshVersion }),
    ...(ssh.sshExecutable === undefined ? {} : { sshExecutable: ssh.sshExecutable }),
  })
  // 端口可以在连的时候才定：代理与「连远端」是两条独立生命期，插件入口先起代理、
  // 用户点连接时才读端口。读晚了没关系，读到 undefined 就是不挂 `-R`（下表已写清后果）。
  // 环境档位在**解析完远端 dsh** 之后才算：隔离档要拼远端 `$HOME`，而那个值只有
  // `resolveRemoteDsh` 同一条检查脚本能拿到（本地 home 拼出来的一定不对）。
  // 远端检查（可能装了东西、也可能只是 stat）走完才看取消：那一步不认 signal，
  // 只能在这里尽早退出，别让它白连着往下起进程。
  abortIfCancelled(control.signal)
  const policy = resolvePolicy(options.envPolicy)
  const injection = planEnvInjection(policy, { home: runtime.remoteHome, hostKey: 'ssh:' + target.alias }, ssh.extraEnv)
  const proxyPort = typeof ssh.proxyPort === 'function' ? ssh.proxyPort() : ssh.proxyPort
  const handle = await launchSshDsh({
    homeDir: ssh.homeDir,
    target: resolved.target,
    auth,
    remoteRoot: target.remoteRoot,
    remotePort: target.port,
    argvPrefix: runtime.argvPrefix,
    ...(ssh.sshExecutable === undefined ? {} : { sshExecutable: ssh.sshExecutable }),
    ...(ssh.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: ssh.connectTimeoutMs }),
    ...(options.launchTimeoutMs === undefined ? {} : { timeoutMs: options.launchTimeoutMs }),
    ...(proxyPort === undefined || proxyPort <= 0 ? {} : { proxyPort }),
    ...(injection.env === undefined ? {} : { extraEnv: injection.env }),
    ...(control.signal === undefined ? {} : { signal: control.signal }),
    onStage: (stage) => control.onPhase?.(stage),
  })
  control.onPhase?.('tunnel')
  return openConnection(handle, policy)
}

/** 握手 + 打包成 `RemoteConnection`；启动器只负责给出一个可连的句柄。 */
async function openConnection(handle: RemoteDshHandle, envPolicy: EnvPolicy): Promise<RemoteConnection> {
  const endpoint = handle.endpoint
  let rpc: RemoteRpc
  try {
    // RemoteRpc.open 内部就是 handshakeRemote：握手只在这里发生一次。
    rpc = await RemoteRpc.open(endpoint, endpoint.token)
  } catch (error) {
    // 握手失败也要把远端进程收掉，否则会留下一个没人用的 dsh 占着端口。
    void handle.dispose()
    throw error
  }
  return {
    get rpc() {
      return rpc
    },
    remoteProxyPort: handle.remoteProxyPort,
    envPolicy,
    /**
     * 只换传输：关掉旧 socket 与 WS，用**同一个** endpoint 再握一次手。
     *
     * endpoint 里的 token 属于这条远端进程，进程没死就一直有效 —— 这正是省掉
     * 冷启动的依据。进程已经没了的话这里会抛（fetch refused / 握手超时），
     * 调用方据此回落到重新 `connect`。
     */
    async rehandshake() {
      rpc.dispose()
      rpc = await RemoteRpc.open(endpoint, endpoint.token)
    },
    dispose() {
      rpc.dispose()
      void handle.dispose()
    },
  }
}

/** 只用于日志与错误说明的一行摘要；**不含**主机名与用户名。 */
export function describeTarget(target: ConnectTarget): string {
  const who = target.backend === 'wsl' ? 'wsl:' + target.distro : 'ssh:' + target.alias
  return who + ':' + String(target.port) + ' ' + target.remoteRoot
}

/**
 * 从 `/attach` 的请求体里读出 target。
 *
 * `backend` 缺省为 `wsl`：P3.5 的探针与既有客户端都不带这个字段，缺省让它们照旧；
 * 显式写 `ssh` 才要求 `alias`，不会把空 `distro` 当成 SSH。
 */
export function readTarget(body: unknown): ConnectTarget {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new TypeError('请求体必须是对象')
  }
  const record = body as Record<string, unknown>
  const backend = record['backend'] ?? 'wsl'
  const port = record['port']
  const remoteRoot = record['remoteRoot']
  if (backend !== 'wsl' && backend !== 'ssh') {
    throw new TypeError('backend 必须是 wsl 或 ssh')
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new TypeError('port 必须是 1–65535 的整数')
  }
  if (typeof remoteRoot !== 'string' || !remoteRoot.startsWith('/')) {
    throw new TypeError('remoteRoot 必须是 POSIX 绝对路径')
  }
  if (backend === 'ssh') {
    const alias = record['alias']
    if (typeof alias !== 'string' || alias === '') throw new TypeError('alias 必须是非空字符串')
    return { backend: 'ssh', alias, port, remoteRoot }
  }
  const distro = record['distro']
  if (typeof distro !== 'string' || distro === '') throw new TypeError('distro 必须是非空字符串')
  return { backend: 'wsl', distro, port, remoteRoot }
}

/** 传输层已经没了、但连接对象仍被持有时，读写 `rpc` 的兜底错误。 */
export function detachedError(): TeleportError {
  return new TeleportError({
    code: 'remote/disconnected',
    detail: '这条远端连接的传输层已经释放，需要先重连',
    nextActions: ['点「重连」再试一次'],
  })
}