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
 *
 * **重连先换传输、不先重启进程**（P3.5.2 真机实测定档）：
 * - 远端进程还活着时，重开一条 cookie + WS 只要 52ms；
 * - 重新拉进程要 9–20s 冷启动，之后**进程内第一次 `session/create` 还要再等**（复用
 *   `~/.dsh` 档实测 123816ms，空档 108ms —— 那是一次性扫描整个会话库的代价，与
 *   workspace 无关，见 spikes/m1/p352-exit-demo/README.md）。
 * 所以传输层断掉时把连接**存进 `#detached` 而不是 dispose**：dispose 会连带杀掉
 * 远端进程，那就等于每次抖动都让用户重付一遍冷启动。
 * 不主动 dispose 也不留孤儿：`launch.ts` 的 `wsl.exe` 句柄是宿主进程的子进程，
 * 宿主一死 OS 就把它带走，distro 侧随之回收（`children.ts` 头注释的 A7 实测）。
 */

import { TeleportError } from '../backend/errors.ts'
import { type LinkPhase, ReconnectDriver, type ReconnectTimers } from '../../shared/reconnect.ts'
import type { AttachDeps, AttachRequest, AttachResult, CreatedSession } from './attach.ts'
import { attachWorkspace, createSession as createRemoteSession } from './attach.ts'
import type { ProbeOptions, ProbeResult } from './probe.ts'
import { TERMINAL_WARMUP_MS, preheatProbe, runSessionProbe } from './probe.ts'
import type { ProjectionRpc } from './remote.ts'
import type { ProjectedSession, ProjectedWorkspace, ProjectionStore } from './store.ts'

/**
 * 一条已建立的远端连接；`dispose` 之后不可再用。
 *
 * `rehandshake` 是**只换传输、不动进程**的那条路：远端进程还活着时，重开一条
 * cookie + WS 只要 5ms，而重新拉起进程要 9.2s 冷启动（真机实测，见 P3.5.2 实验）。
 * 它是可选的：单测的假连接不需要它，没有就当「做不到」，直接回落到重新 `connect`。
 */
export interface RemoteConnection {
  readonly rpc: ProjectionRpc
  rehandshake?(): Promise<void>
  dispose(): void
}

/**
 * 连到哪台远端。
 *
 * 判别联合而不是「一堆可选字段」：`backend` 决定下面该读哪个标识（WSL 读发行版名，
 * SSH 读 config 别名）。写成可选字段就会出现「两者都有」或「两者都没有」的非法态，
 * 而这两种态在投影与重连里都没法分派。
 *
 * **这里只放用户选择，不放凭据**：`ConnectTarget` 会原样进 `/snapshot` 的 HTTP
 * 响应（面板要显示连的是谁），主机名/用户名/私钥由 live 层按别名解析（铁律 3）。
 */
export interface WslConnectTarget {
  readonly backend: 'wsl'
  readonly distro: string
  /** 远端 dsh 监听的端口（`--port`）。 */
  readonly port: number
  /** 远端检出根（POSIX 绝对路径），用于日志与错误说明。 */
  readonly remoteRoot: string
}

/** SSH 目标：只记 `~/.ssh/config` 里的别名，余下交给 live 层解析。 */
export interface SshConnectTarget {
  readonly backend: 'ssh'
  readonly alias: string
  readonly port: number
  readonly remoteRoot: string
}

export type ConnectTarget = WslConnectTarget | SshConnectTarget

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
  /**
   * 传输层已断、但远端进程可能还活着的连接。
   *
   * 与 `#live` 互斥：它在的时候「连不上」（面板显示 offline），但进程还占着端口，
   * 所以重连时先试 `rehandshake()` 而不是重新拉起进程。dispose 掉就等于放弃了
   * 那 52ms 的便宜路径，回到 9–20s 冷启动。
   */
  #detached: { readonly target: ConnectTarget; readonly connection: RemoteConnection } | undefined

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
      attachWorkspace(attachDeps(target, connection.rpc, this.#store), request),
    )
  }

  /**
   * 在已投影的工作区里建会话；没连着就明确报错，不静默回落。
   *
   * 会话建好后**顺手把取证终端也建出来**（`preheatProbe`）：建终端要走一次远端往返
   * （真机实测 33–254ms），提前建好就能把这段从用户等待里拿掉。走慢 shell（远端默认
   * bash + ble.sh）时它还顺带把 1.4–1.8s 的启动开销提前付掉（会话首命令 1776ms →
   * 364ms）；走快 shell（fish）时那笔开销不存在，首命令本身只要 150ms。
   *
   * 预热失败**不拖垮建会话**：会话是用户要的东西，终端只是加速手段。失败信息挂在
   * `preheatError` 上交给面板显示（铁律 4 允许「局部失败」，禁止的是静默）。
   */
  async createSession(workspaceId: string, options: { signal?: AbortSignal; agentPreset?: string } = {}): Promise<CreatedSession> {
    const connection = this.#requireLive()
    return this.#guardTransport(async () => {
      const deps = { rpc: connection.rpc, store: this.#store }
      let preheatError: TeleportError | undefined
      const created = await createRemoteSession(deps, workspaceId, {
        ...options,
        preheat: async (sessionId) => {
          try {
            return await preheatProbe(deps, sessionId, options.signal === undefined ? {} : { signal: options.signal })
          } catch (error) {
            preheatError = asTeleportError(error)
            return undefined
          }
        },
      })
      return preheatError === undefined ? created : { ...created, preheatError }
    })
  }

  /**
   * 在远端会话的终端里跑取证命令。
   *
   * **预热窗口按后端给缺省值**（`defaultWarmupMs`）：WSL 的默认 shell 会跑 `ble.sh`，
   * 新终端要 1.5s 才「能秒回命令」；SSH 目标上这条经验不成立——2026-11-13 在 gcp 上量的
   * 四组（warmup 0 / 600 / 1200 / 2000 → 2139 / 2714 / 3312 / 5321 ms）是**严格线性**的，
   * 说明等待纯属叠加、没有任何初始化积压可等。给 SSH 留 1.5s 会把首命令从 2.1s 推过 3s 门禁。
   *
   * 反向条件：哪天在 SSH 目标上遇到「rc 很重」的机器（首命令莫名要 2–3s），把它当作
   * `remote/probe-slow` 的证据，改成「先发一条暖机命令、等它回来再发真命令」，而不是把
   * 常数调回去——两者的区别是前者有可观测就绪信号，后者是猜。
   */
  async probe(sessionId: string, options: ProbeOptions = {}): Promise<ProbeResult> {
    const connection = this.#requireLive()
    const withDefaults: ProbeOptions =
      options.warmupMs === undefined
        ? { ...options, warmupMs: defaultWarmupMs(this.target) }
        : options
    return this.#guardTransport(() => runSessionProbe({ rpc: connection.rpc }, sessionId, withDefaults))
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
    // **只断传输，不杀远端进程**（architecture.md §8.5：回收归退出/cleanup，
    // 不归断开）。这就让「断开 → 重连」变成 52ms 的重握手，而不是 9–20s 冷启动。
    // 远端进程不会因此变孤儿：它是宿主 `wsl.exe` 句柄的子进程，宿主一退
    // OS 就把它带走（children.ts 的 A7 实测）。
    if (live !== undefined) this.#detatch(live)
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

  /**
   * 真回收：把还活着的远端连接（含留存的）全部收掉，连远端进程一起。
   *
   * 只在「用户真的不打算再用这台远端」时调（进程退出、切 target）。
   * 日常的「断开」走 `disconnect()` —— 那条只断传输，进程留着温热。
   */
  recycle(): void {
    const live = this.#live
    this.#live = undefined
    this.#stopDriver()
    live?.connection.dispose()
    this.#dropDetached()
  }

  /** 进程退出：释放连接（不标 offline，因为没人会再看这份内存表）。 */
  dispose(): void {
    const live = this.#live
    this.#live = undefined
    this.#stopDriver()
    live?.connection.dispose()
    this.#dropDetached()
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

  /**
   * 传输层断了：**保住连接对象**，只把它挪进 `#detached`。
   *
   * 为什么不 dispose：`dispose()` 会连远端进程一起收（那是它的契约）。
   * 断线时远端进程通常还活着，收掉它等于把「52ms 重握手」换成「9–20s 冷启动 +
   * 进程内首次建会话的整库扫描」。只有目标变了或用户显式断开才该真收。
   */
  #onTransportLost(): void {
    const live = this.#live
    this.#live = undefined
    this.#store.markAllOffline()
    if (live !== undefined) this.#detatch(live)
    const target = live?.target ?? this.#detached?.target ?? this.#lastTarget
    if (target === undefined) return
    this.#startDriver(target)
  }

  /** 保存一条「传输断了、进程可能还活着」的连接；同一 target 只留一条。 */
  #detatch(entry: { readonly target: ConnectTarget; readonly connection: RemoteConnection }): void {
    const previous = this.#detached
    if (previous !== undefined && previous.connection !== entry.connection) previous.connection.dispose()
    this.#detached = entry
  }

  /** 真收掉留存连接（目标变了、用户断开、进程退出时才调）。 */
  #dropDetached(): void {
    const entry = this.#detached
    this.#detached = undefined
    entry?.connection.dispose()
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
      const connection = await this.#reacquire(target)
      this.#live = { target, connection }
      this.#lastTarget = target
      this.#detached = undefined
    }
    const live = this.#live
    if (live === undefined) return
    const deps = attachDeps(target, live.connection.rpc, this.#store)
    for (const workspace of this.#store.workspaces()) {
      const remotePath = workspace.remotePath
      if (remotePath === null) continue
      await attachWorkspace(deps, { remotePath, localPath: workspace.localPath, title: workspace.title })
    }
  }

  /**
   * 拿回一条可用连接：**先试只换传输，不行才重新起进程**。
   *
   * 顺序不能反。`rehandshake` 失败说明远端进程真的没了（fetch refused / 握手超时），
   * 这时才付冷启动；反过来先重启的话，每次网络抖动都会让用户白等 9–20s。
   * 换了 target 就不该走这条路 —— 那是另一次接入，不是重连。
   */
  async #reacquire(target: ConnectTarget): Promise<RemoteConnection> {
    const detached = this.#detached
    if (detached !== undefined && sameTarget(detached.target, target)) {
      const rehandshake = detached.connection.rehandshake
      if (typeof rehandshake === 'function') {
        try {
          await rehandshake.call(detached.connection)
          return detached.connection
        } catch {
          // 进程真的没了：把这条残连接收干净，下面重新起一个。
        }
      } else {
        // 没有这条能力（假连接 / 别家实现）：老实回收，别占着端口。
        detached.connection.dispose()
      }
      this.#detached = undefined
    } else if (detached !== undefined) {
      // 留着一条别的 target 的残连接没有意义。
      this.#dropDetached()
    }
    return this.#connect(target)
  }

  async #ensure(target: ConnectTarget): Promise<RemoteConnection> {
    const live = this.#live
    if (live !== undefined && sameTarget(live.target, target)) return live.connection
    const detached = this.#detached
    // 同 target 的留存连接可以直接救回来 —— 这正是「再点一次接入」不该重付冷启动的原因。
    if (detached !== undefined && sameTarget(detached.target, target)) {
      const rehandshake = detached.connection.rehandshake
      if (typeof rehandshake === 'function') {
        try {
          await rehandshake.call(detached.connection)
          this.#detached = undefined
          this.#live = { target, connection: detached.connection }
          this.#lastTarget = target
          this.#stopDriver()
          return detached.connection
        } catch {
          this.#dropDetached()
        }
      } else {
        this.#dropDetached()
      }
    }
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

/** 把任意抛出物归一成 `TeleportError`：面板要能显示 code，而不是一句 `[object Object]`。 */
function asTeleportError(error: unknown): TeleportError {
  if (error instanceof TeleportError) return error
  return new TeleportError({
    code: 'remote/unknown',
    detail: error instanceof Error ? error.message : String(error),
    nextActions: ['重试', '查看远端日志'],
  })
}

/**
 * 把连接目标翻译成投影依赖。
 *
 * `distro` 对非 WSL 后端必须是 null：`attach.ts` 拿它算本地 UNC 路径，SSH 的本地
 * 路径来自锚点目录（S9.5b-2）；冒充成发行版名会拼出一条不存在的 UNC。
 */
/**
 * 取证预热窗口的缺省值：只有「默认 shell 会跑重 rc」的后端才需要等。
 *
 * 为什么写在服务层而不是 `probe.ts` 里：这是**后端事实**（WSL 的 bash 装了 ble.sh，
 * SSH 目标上通常没有），探针层只看得到「要不要换 fish」，看不到连的是哪一种后端。
 */
export function defaultWarmupMs(target: ConnectTarget | null): number {
  return target !== null && target.backend === 'ssh' ? 0 : TERMINAL_WARMUP_MS
}
export function attachDeps(
  target: ConnectTarget,
  rpc: ProjectionRpc,
  store: ProjectionStore,
): AttachDeps {
  return target.backend === 'wsl'
    ? { rpc, store, backend: 'wsl', distro: target.distro }
    : { rpc, store, backend: 'ssh', distro: null }
}

/** 两台远端是否「同一条连接」。换后端就是另一台，哪怕端口与检出根一模一样。 */
export function sameTarget(left: ConnectTarget, right: ConnectTarget): boolean {
  if (left.backend !== right.backend) return false
  if (left.port !== right.port || left.remoteRoot !== right.remoteRoot) return false
  if (left.backend === 'wsl' && right.backend === 'wsl') return left.distro === right.distro
  if (left.backend === 'ssh' && right.backend === 'ssh') return left.alias === right.alias
  return false
}