/**
 * WSL 后端的 `RemoteBackend` 实现：把 M1 就有的自由函数（`runInDistro` / `launchRemoteDsh`）
 * 收成接口形态，让上层只认「探测 / 启动 / 回收」三个动词。
 *
 * 为什么现在补这一层：M2 的 SSH 已能跑（S9 真机 7/7），但投影/提示词/工具层仍硬编码
 * `backend: 'wsl'`。要让 SSH 接进去，上头必须有一个**同一形态**的对象可拿到——
 * 否则「按 kind 分派」这件事没地方落脚。
 *
 * 刻意不做的事：
 * - **不探测 mirrored 网络模式**。`wsl --list --verbose` 没有这一列，要判定得去读
 *   `/etc/resolv.conf` 或 `ip route`，那是 env-policy 的活；这里如实给 `undefined`，
 *   不冒充 `false`（`false` 会被上层读成「确认是 NAT 模式」）。
 * - **不管端口是否已释放**。那是 launch 的看门狗与 dispose 的职责，不是后端的。
 */

import { TeleportError } from '../errors.ts'
import type { BackendProbe, LaunchRequest, RemoteBackend } from '../backend.ts'
import type { RemoteDshHandle } from '../handle.ts'
import {
  buildProbeScript,
  emptyToUndefined,
  parseProbeOutput,
  shellQuote,
} from '../posix-probe.ts'
import { runInDistro as defaultRunInDistro } from './exec.ts'
import { launchRemoteDsh as defaultLaunchRemoteDsh, type LaunchOptions } from './launch.ts'

/** 单测注入点：`runInDistro` 的窄化签名，只需它真用到的字段。 */
export type RunInDistroLike = (
  executable: string,
  distro: string,
  command: readonly string[],
  options?: { timeoutMs?: number },
) => Promise<{ stdoutText: string; stderrText: string; exitCode: number | null }>

export type LaunchLike = (options: LaunchOptions) => Promise<RemoteDshHandle>

export interface WslRemoteBackendOptions {
  readonly distro: string
  /** `wsl.exe` 路径；默认交给 `launch.ts` 的默认值。 */
  readonly executable?: string
  /** 探测超时，默认 20s：`uname` + `node -v` 在同一台机上通常 100ms 内，留足冷启动余量。 */
  readonly probeTimeoutMs?: number
  readonly runInDistro?: RunInDistroLike
  readonly launch?: LaunchLike
}

const DEFAULT_PROBE_TIMEOUT_MS = 20_000

export class WslRemoteBackend implements RemoteBackend {
  readonly kind = 'wsl' as const
  readonly target: string

  readonly #executable: string | undefined
  readonly #probeTimeoutMs: number
  readonly #runInDistro: RunInDistroLike
  readonly #launch: LaunchLike
  /** 自己起的每一个句柄；`dispose()` 只碰这里的东西（铁律：只杀自己起的）。 */
  #handles: RemoteDshHandle[] = []

  constructor(options: WslRemoteBackendOptions) {
    this.target = options.distro
    this.#executable = options.executable
    this.#probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
    this.#runInDistro = options.runInDistro ?? (defaultRunInDistro as RunInDistroLike)
    this.#launch = options.launch ?? defaultLaunchRemoteDsh
  }

  async probe(): Promise<BackendProbe> {
    const result = await this.#runInDistro(
      this.#executable ?? 'wsl.exe',
      this.target,
      ['sh', '-c', shellQuote(buildProbeScript())],
      { timeoutMs: this.#probeTimeoutMs },
    )
    const parsed = parseProbeOutput(result.stdoutText)

    if (!parsed.complete || parsed.conflicts.length > 0) {
      const reasons: string[] = []
      if (!parsed.complete) reasons.push('输出里没有结束标记（脚本没跑完或输出被截断）')
      if (parsed.conflicts.length > 0) reasons.push('同一字段给出两个不同的值：' + parsed.conflicts.join('、'))
      throw new TeleportError({
        code: 'remote/probe-incomplete',
        detail: '探测 WSL 发行版 ' + this.target + ' 的结果不可用：' + reasons.join('；'),
        nextActions: [
          '确认发行版在运行：wsl.exe --list --verbose',
          '重试探测',
          '检查该发行版 ~/.bashrc 是否往标准输出打东西（sh -c 不走 bashrc，但 alias 可能被继承）',
        ],
      })
    }

    return {
      kind: 'wsl',
      target: this.target,
      home: parsed.values.home ?? '',
      nodeVersion: emptyToUndefined(parsed.values.node),
      dshVersion: emptyToUndefined(parsed.values.dsh),
      hasDshHome: parsed.values.dshhome === '1',
      // `wsl --list --verbose` 没有网络模式列；未探测就留空，不冒充 false。
      mirroredNetwork: undefined,
    }
  }

  async launch(request: LaunchRequest): Promise<RemoteDshHandle> {
    const handle = await this.#launch({
      ...(this.#executable === undefined ? {} : { executable: this.#executable }),
      distro: this.target,
      remoteRoot: request.remoteRoot,
      port: request.port,
      ...(request.nodeCommand === undefined ? {} : { nodeCommand: request.nodeCommand }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    this.#handles.push(handle)
    return handle
  }

  /**
   * 回收自己起的全部句柄。可重复调用：第二次起没有句柄，直接答 `clean: true`。
   *
   * 全有全无地记账：只要有一个句柄说自己不干净，`clean` 就是 false —— 上层据此决定
   * 是否把「退出后仍有残留」报给用户，不能因为别的句柄干净就把它盖过去。
   */
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
