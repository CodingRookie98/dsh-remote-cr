/**
 * SSH 后端的 `RemoteBackend` 实现：把 S3–S9 攒下的自由函数收成接口形态。
 *
 * 与 WSL 版的差别只有三处，且都在实现里：
 * - 探测走 `probeSshTarget`（**首次接触就是 TOFU 发生的地方**，所以必须走 `connectRemote`）；
 * - 启动要 `target/auth/homeDir`（连接参数不是「一个发行版名」能表达的）；
 * - `dispose()` 收的是 `SshRemoteHandle`，它比中立的句柄多 `localPort` 等字段，
 *   但回收语义一样：只碰自己起的那个进程树。
 *
 * 刻意不做的事：**不在这里 bootstrap**。装包/上传是 `S9` 引导器的职责，后端只负责
 * 「在一个已经能跑 dsh 的目标上把它拉起来」；把安装混进来会让 probe 与 launch 的成功
 * 条件纠缠（装了但没装对，究竟算探测失败还是启动失败说不清）。
 */

import { RemoteCrError } from '../errors.ts'
import type { BackendProbe, LaunchRequest, RemoteBackend } from '../backend.ts'
import type { RemoteDshHandle } from '../handle.ts'
import type { SshTarget } from './config.ts'
import { probeSshTarget, type SshProbeRequest, type SshProbeResult } from './probe.ts'
import {
  launchSshDsh,
  type SshLaunchOptions,
  type SshRemoteHandle,
} from './launch.ts'
import type { SshAuth } from './transport.ts'

export type ProbeLike = (request: SshProbeRequest) => Promise<SshProbeResult>
export type SshLaunchLike = (options: SshLaunchOptions) => Promise<SshRemoteHandle>

export interface SshRemoteBackendOptions {
  /** 本地 home，用于展开 `~` 与 known_hosts 账本位置。 */
  readonly homeDir: string
  readonly target: SshTarget
  readonly auth: SshAuth
  /** 远端监听端口；不给就交给 `launchSshDsh` 的默认值（8899）。 */
  readonly remotePort?: number
  /** 本地隧道口；不给就让内核挑。 */
  readonly localPort?: number
  /** 本地凭据代理端口；给了才挂 `-R`。 */
  readonly proxyPort?: number
  readonly sshExecutable?: string
  readonly askpassPath?: string
  /** 探测超时，默认 30s：SSH 握手 + 一次远端 sh 比 WSL 慢。 */
  readonly probeTimeoutMs?: number
  /** 单测注入点。 */
  readonly probe?: ProbeLike
  readonly launch?: SshLaunchLike
}

const DEFAULT_PROBE_TIMEOUT_MS = 30_000

export class SshRemoteBackend implements RemoteBackend {
  readonly kind = 'ssh' as const
  readonly target: string

  readonly #homeDir: string
  readonly #target: SshTarget
  readonly #auth: SshAuth
  readonly #probeTimeoutMs: number
  readonly #options: SshRemoteBackendOptions
  readonly #probe: ProbeLike
  readonly #launch: SshLaunchLike
  #handles: SshRemoteHandle[] = []

  constructor(options: SshRemoteBackendOptions) {
    this.#homeDir = options.homeDir
    this.#target = options.target
    this.#auth = options.auth
    this.#probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
    this.#options = options
    this.#probe = options.probe ?? probeSshTarget
    this.#launch = options.launch ?? launchSshDsh
    // 目标标识就用人写的那个 `user@host:port`；它就是用户在配置里认得出的东西。
    this.target = options.target.alias
  }

  async probe(): Promise<BackendProbe> {
    try {
      const result = await this.#probe({
        homeDir: this.#homeDir,
        target: this.#target,
        auth: this.#auth,
        ...(this.#options.sshExecutable === undefined ? {} : { sshExecutable: this.#options.sshExecutable }),
        ...(this.#options.askpassPath === undefined ? {} : { askpassPath: this.#options.askpassPath }),
        deadlineMs: this.#probeTimeoutMs,
      })
      return result.probe
    } catch (error) {
      // 指纹不匹配、认证失败这类都是 RemoteCrError，原样上抛（phase 已由 errors.ts 分好）。
      // 只有「不是 RemoteCrError」的意外才包一层，避免上层拿到裸 Error 无从展示。
      if (isRemoteCrErrorLike(error)) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new RemoteCrError({
        code: 'remote/probe-incomplete',
        detail: '探测 SSH 目标 ' + this.target + ' 失败：' + message,
        nextActions: ['重试探测', '确认远端可达：ssh -v <目标>', '检查私钥权限与 known_hosts'],
      })
    }
  }

  async launch(request: LaunchRequest): Promise<RemoteDshHandle> {
    const handle = await this.#launch({
      homeDir: this.#homeDir,
      target: this.#target,
      auth: this.#auth,
      remoteRoot: request.remoteRoot,
      ...(this.#options.remotePort === undefined ? {} : { remotePort: this.#options.remotePort }),
      ...(this.#options.localPort === undefined ? {} : { localPort: this.#options.localPort }),
      ...(this.#options.proxyPort === undefined ? {} : { proxyPort: this.#options.proxyPort }),
      ...(request.nodeCommand === undefined ? {} : { nodeCommand: request.nodeCommand }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(this.#options.sshExecutable === undefined ? {} : { sshExecutable: this.#options.sshExecutable }),
      ...(this.#options.askpassPath === undefined ? {} : { askpassPath: this.#options.askpassPath }),
    })
    this.#handles.push(handle)
    return handle
  }

  /** 回收自己起的全部句柄；可重复调用。任一不干净 ⇒ `clean: false`。 */
  async dispose(): Promise<{ readonly clean: boolean }> {
    const handles = this.#handles
    this.#handles = []
    let clean = true
    for (const handle of handles) {
      const ok = await handle.dispose()
      if (!ok) clean = false
    }
    return { clean }
  }
}

/** 只判形状：`errors.ts` 的 RemoteCrError 有 code/phase/nextActions 三件套。 */
function isRemoteCrErrorLike(value: unknown): value is RemoteCrError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'phase' in value &&
    'nextActions' in value
  )
}
