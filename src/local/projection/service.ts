/**
 * 投影服务：把「远端会话/工作区」的生命周期收在一处（宿主半）。
 *
 * 为什么需要它，而不是让路由直接拼 `attachWorkspace`：
 * - **连接是有状态的**。一次 `/connect` 换来一条 cookie + 一组 WS（`architecture.md`
 *   §8.3 单通道），后续的 `session/create`、`terminal/attach` 都要复用同一条连接；
 *   路由层要是每次都重新握手，就会为每个请求造一条新隧道。
 * - **断连要能一次标完**。A7 要求「断线后工作区状态可见」，所以必须有一个地方
 *   统一 `markAllOffline()`，而不是等某条路由偶然发现失败。
 *
 * 生命周期四个动作：`attach`（连上并投影）、`disconnect`（标 offline 并释放）、
 * `reconnectNow`（手动重连）、`dispose`（进程退出时释放）。
 *
 * **自动重连在 P3.5.1 接进来了**（原先文件头写「没有自动重连」，那是 P3.5 的分工）。
 * 触发条件是**传输层失败**（`remote/tunnel-unavailable`），不是任何业务错误：
 * 远端把一次 RPC 拒了是业务结论，重连一万次也还是拒；隧道断了才需要重连。
 * 调度交给 `shared/reconnect.ts` 的 `ReconnectDriver`（2s/4s/8s ×3 轮，之后每 2min），
 * 这里只负责「连回来之后把投影表按远端重建」。
 */

import { TeleportError } from '../backend/errors.ts'
import { type LinkPhase, ReconnectDriver, type ReconnectTimers } from '../../shared/reconnect.ts'
import type { AttachRequest, AttachResult, CreatedSession } from './attach.ts'
import { attachWorkspace, createSession as createRemoteSession } from './attach.ts'
import type { ProbeOptions, ProbeResult } from './probe.ts'
import { runSessionProbe } from './probe.ts'
import type { ProjectionRpc } from './remote.ts'
import type { ProjectedSession, ProjectedWorkspace, ProjectionStore } from './store.ts'

/** 一条已建立的远端连接；`dispose` 之后不可再用。 */
export interface RemoteConnection {
  readonly rpc: ProjectionRpc
  dispose(): void
}

/** 连到哪台远端：v1 只有 WSL，字段留足但不预设多后端。 */
export interface ConnectTarget {
  readonly distro: string
  /** 远端 dsh 监听的端口（`--port`）。 */
  readonly port: number
  /** 远端检出根（POSIX 绝对路径），用于日志与错误说明。 */
  readonly remoteRoot: string
}

export interface ProjectionServiceOptions {
  readonly store: ProjectionStore
  /** 建立连接；真实实现是 launch + handshake，测试注入假实现。 */
  connect(target: ConnectTarget): Promise<RemoteConnection>
  /** 重连定时器接缝；单测注入假定时器，生产用全局 `setTimeout`。 */
  readonly timers?: ReconnectTimers
}

/** 面板要的全部投影数据。 */
export interface ProjectionSnapshot {
  readonly workspaces: readonly ProjectedWorkspace[]
  readonly sessions: readonly ProjectedSession[]
  readonly connected: boolean
  readonly target: ConnectTarget | null
  /** 连接相位：`idle` / `connected` / `retrying` / `offline`。 */
  readonly link: LinkPhase
}

/** 投影服务对外的一整套动作。 */
export class ProjectionService {
  readonly #store: ProjectionStore
  readonly #connect: (target: ConnectTarget) => Promise<RemoteConnection>
  readonly #timers: ReconnectTimers | undefined
  #live: { readonly target: ConnectTarget; readonly connection: RemoteConnection } | undefined
  /**
   * 上一次成功连上的 target。
   *
   * 单独记一份而不是复用 `#live.target`：断线后 `#live` 已经清了，但「要连回哪儿」
   * 必须还知道，否则自动重连无从下手、面板也没法显示目标。
   */
  #lastTarget: ConnectTarget | undefined
  #driver: { readonly target: ConnectTarget; readonly driver: ReconnectDriver } | undefined

  constructor(options: ProjectionServiceOptions) {
    this.#store = options.store
    this.#connect = options.connect
    this.#timers = options.timers
  }

  get connected(): boolean {
    return this.#live !== undefined
  }

  /** 接入目标：连着的用 `#live`，断线后仍记得上一次的目标（面板要显示它）。 */
  get target(): ConnectTarget | null {
    return this.#live?.target ?? this.#lastTarget ?? null
  }

  /** 连接相位。四态穷尽，面板据此显示一行动作文案。 */
  get link(): LinkPhase {
    if (this.#live !== undefined) return 'connected'
    const driver = this.#driver
    return driver === undefined ? 'idle' : driver.driver.state.phase
  }

  /**
   * 连上远端并把指定目录接成投影工作区。
   *
   * 已经连着**同一个 target** 时复用连接：重复 `/connect` 不该把远端隧道重开一遍
   * （那会换 cookie，让上一批 WS 全部失效）。target 变了才重建。
   */
  async attach(target: ConnectTarget, request: AttachRequest): Promise<AttachResult> {
    const connection = await this.#ensure(target)
    return this.#guardTransport(() =>
      attachWorkspace(
        { rpc: connection.rpc, store: this.#store, backend: 'wsl', distro: target.distro },
        request,
      ),
    )
  }

  /** 在已投影的工作区里建会话；没连着就明确报错，不静默回落。 */
  async createSession(workspaceId: string, options: { signal?: AbortSignal; agentPreset?: string } = {}): Promise<CreatedSession> {
    const connection = this.#requireLive()
    return this.#guardTransport(() => createRemoteSession({ rpc: connection.rpc, store: this.#store }, workspaceId, options))
  }

  /** 在远端会话的终端里跑取证命令。 */
  async probe(sessionId: string, options: ProbeOptions = {}): Promise<ProbeResult> {
    const connection = this.#requireLive()
    return this.#guardTransport(() => runSessionProbe({ rpc: connection.rpc }, sessionId, options))
  }

  /** 面板数据：投影表 + 连接状态。 */
  snapshot(): ProjectionSnapshot {
    const workspaces = this.#store.workspaces()
    const sessions: ProjectedSession[] = []
    for (const workspace of workspaces) sessions.push(...this.#store.sessions(workspace.id))
    return {
      workspaces,
      sessions,
      connected: this.connected,
      target: this.target,
      link: this.link,
    }
  }

  /**
   * 断连：**只标 offline、不删条目**（A7）。
   *
   * 连接释放后仍留着投影，用户才能看到「它还在，只是现在连不上」。
   * 手动断连同时**停掉自动重连**：用户的意图就是「别再试了」。
   */
  disconnect(): void {
    const live = this.#live
    this.#live = undefined
    this.#stopDriver()
    this.#store.markAllOffline()
    live?.connection.dispose()
  }

  /**
   * 手动重连：立刻试一次；失败就把自动重连挂起来。
   *
   * 为什么不用 `ReconnectDriver.reconnectNow()`：那是「排一次、不报结果」的 fire-and-forget，
   * 而面板上按一下必须当场知道成没成。这里直接 await 一次，失败时再挂驱动。
   */
  async reconnectNow(): Promise<void> {
    const target = this.#lastTarget
    if (target === undefined) {
      throw new TeleportError({
        code: 'remote/disconnected',
        detail: '还没有连过任何远端，无从重连',
        nextActions: ['先在瞬移面板里接入一个远端工作区'],
      })
    }
    this.#stopDriver()
    try {
      await this.#attemptReconnect(target)
    } catch (error) {
      this.#startDriver(target)
      throw error
    }
  }

  /** 进程退出：释放连接（不标 offline，因为没人会再看这份内存表）。 */
  dispose(): void {
    const live = this.#live
    this.#live = undefined
    this.#stopDriver()
    live?.connection.dispose()
  }

  /**
   * 传输层失败 → 清连接、标 offline、挂上自动重连。
   *
   * 只认 `remote/tunnel-unavailable`：`remote/unknown` 可能是远端把业务拒绝了
   * （例如参数不合法），那种情况重连是白费。
   */
  async #guardTransport<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      if (isTransportLoss(error)) this.#onTransportLost()
      throw error
    }
  }

  #onTransportLost(): void {
    const live = this.#live
    this.#live = undefined
    this.#store.markAllOffline()
    live?.connection.dispose()
    const target = live?.target ?? this.#lastTarget
    if (target === undefined) return
    this.#startDriver(target)
  }

  #startDriver(target: ConnectTarget): void {
    this.#stopDriver()
    const driver = new ReconnectDriver({
      attempt: () => this.#attemptReconnect(target),
      ...(this.#timers === undefined ? {} : { timers: this.#timers }),
    })
    this.#driver = { target, driver }
    driver.start()
  }

  #stopDriver(): void {
    const entry = this.#driver
    this.#driver = undefined
    entry?.driver.dispose()
  }

  /**
   * 一次重连尝试：连回来，然后**按远端重建投影表**。
   *
   * 为什么重建：断线后远端可能已经多出/少了会话，本地这份是呈现缓存
   * （`store.ts` 头注释第 2 条），不重建就等于拿旧表骗用户。
   * 重建方式是**逐条重放 `workspace/create`**（远端实测幂等，P35-2 已取证）：
   * 远端没有 `workspace/list`，唯一能枚举的入口是 `follow` 流，而那要长连接；
   * 我们记得自己接过哪些目录，重放一遍比常驻一条流便宜得多。
   */
  async #attemptReconnect(target: ConnectTarget): Promise<void> {
    if (this.#live === undefined) {
      const connection = await this.#connect(target)
      this.#live = { target, connection }
      this.#lastTarget = target
    }
    const live = this.#live
    if (live === undefined) return
    const deps = { rpc: live.connection.rpc, store: this.#store, backend: 'wsl' as const, distro: target.distro }
    for (const workspace of this.#store.workspaces()) {
      const remotePath = workspace.remotePath
      if (remotePath === null) continue
      await attachWorkspace(deps, { remotePath, localPath: workspace.localPath, title: workspace.title })
    }
  }

  async #ensure(target: ConnectTarget): Promise<RemoteConnection> {
    const live = this.#live
    if (live !== undefined && sameTarget(live.target, target)) return live.connection
    if (live !== undefined) this.disconnect()
    const connection = await this.#connect(target)
    this.#live = { target, connection }
    this.#lastTarget = target
    this.#stopDriver()
    return connection
  }

  #requireLive(): RemoteConnection {
    const live = this.#live
    if (live === undefined) {
      throw new TeleportError({
        code: 'remote/disconnected',
        detail: '还没有连接到远端：先完成一次「添加远端工作区」',
        nextActions: ['在瞬移面板里接入一个远端工作区', '点「重连」再试一次'],
      })
    }
    return live.connection
  }
}

/** 传输层失败：隧道断了 / 握手超时。业务拒绝不算。 */
function isTransportLoss(error: unknown): boolean {
  return error instanceof TeleportError && error.code === 'remote/tunnel-unavailable'
}

function sameTarget(left: ConnectTarget, right: ConnectTarget): boolean {
  return left.distro === right.distro && left.port === right.port && left.remoteRoot === right.remoteRoot
}
