/**
 * 投影服务：把「远端会话/工作区」的生命周期收在一处（宿主半）。
 *
 * 为什么需要它，而不是让路由直接拼 \`attachWorkspace\`：
 * - **连接是有状态的**。一次 \`/connect\` 换来一条 cookie + 一组 WS（\`architecture.md\`
 *   §8.3 单通道），后续的 \`session/create\`、\`terminal/attach\` 都要复用同一条连接；
 *   路由层要是每次都重新握手，就会为每个请求造一条新隧道。
 * - **断连要能一次标完**。A7 要求「断线后工作区状态可见」，所以必须有一个地方
 *   统一 \`markAllOffline()\`，而不是等某条路由偶然发现失败。
 *
 * 生命周期只有三种动作：\`attach\`（连上并投影）、\`disconnect\`（标 offline 并释放）、
 * \`dispose\`（进程退出时释放）。**没有自动重连**——重连属于 P3.5.1 的调度器，
 * 混进来的话「断线」和「重连中」这两种状态就分不清了。
 */

import type { AttachRequest, AttachResult, CreatedSession } from './attach.ts'
import { attachWorkspace, createSession as createRemoteSession } from './attach.ts'
import type { ProbeOptions, ProbeResult } from './probe.ts'
import { runSessionProbe } from './probe.ts'
import type { ProjectionRpc } from './remote.ts'
import type { ProjectedSession, ProjectedWorkspace, ProjectionStore } from './store.ts'

/** 一条已建立的远端连接；\`dispose\` 之后不可再用。 */
export interface RemoteConnection {
  readonly rpc: ProjectionRpc
  dispose(): void
}

/** 连到哪台远端：v1 只有 WSL，字段留足但不预设多后端。 */
export interface ConnectTarget {
  readonly distro: string
  /** 远端 dsh 监听的端口（\`--port\`）。 */
  readonly port: number
  /** 远端检出根（POSIX 绝对路径），用于日志与错误说明。 */
  readonly remoteRoot: string
}

export interface ProjectionServiceOptions {
  readonly store: ProjectionStore
  /** 建立连接；真实实现是 launch + handshake，测试注入假实现。 */
  connect(target: ConnectTarget): Promise<RemoteConnection>
}

/** 面板要的全部投影数据。 */
export interface ProjectionSnapshot {
  readonly workspaces: readonly ProjectedWorkspace[]
  readonly sessions: readonly ProjectedSession[]
  readonly connected: boolean
  readonly target: ConnectTarget | null
}

/** 投影服务对外的一整套动作。 */
export class ProjectionService {
  readonly #store: ProjectionStore
  readonly #connect: (target: ConnectTarget) => Promise<RemoteConnection>
  #live: { readonly target: ConnectTarget; readonly connection: RemoteConnection } | undefined

  constructor(options: ProjectionServiceOptions) {
    this.#store = options.store
    this.#connect = options.connect
  }

  get connected(): boolean {
    return this.#live !== undefined
  }

  get target(): ConnectTarget | null {
    return this.#live?.target ?? null
  }

  /**
   * 连上远端并把指定目录接成投影工作区。
   *
   * 已经连着**同一个 target** 时复用连接：重复 \`/connect\` 不该把远端隧道重开一遍
   * （那会换 cookie，让上一批 WS 全部失效）。target 变了才重建。
   */
  async attach(target: ConnectTarget, request: AttachRequest): Promise<AttachResult> {
    const connection = await this.#ensure(target)
    const result = await attachWorkspace(
      { rpc: connection.rpc, store: this.#store, backend: 'wsl', distro: target.distro },
      request,
    )
    return result
  }

  /** 在已投影的工作区里建会话；没连着就明确报错，不静默回落。 */
  async createSession(workspaceId: string, options: { signal?: AbortSignal; agentPreset?: string } = {}): Promise<CreatedSession> {
    const connection = this.#requireLive()
    return createRemoteSession({ rpc: connection.rpc, store: this.#store }, workspaceId, options)
  }

  /** 在远端会话的终端里跑取证命令。 */
  async probe(sessionId: string, options: ProbeOptions = {}): Promise<ProbeResult> {
    const connection = this.#requireLive()
    return runSessionProbe({ rpc: connection.rpc }, sessionId, options)
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
    }
  }

  /**
   * 断连：**只标 offline、不删条目**（A7）。
   *
   * 连接释放后仍留着投影，用户才能看到「它还在，只是现在连不上」。
   */
  disconnect(): void {
    const live = this.#live
    this.#live = undefined
    this.#store.markAllOffline()
    live?.connection.dispose()
  }

  /** 进程退出：释放连接（不标 offline，因为没人会再看这份内存表）。 */
  dispose(): void {
    const live = this.#live
    this.#live = undefined
    live?.connection.dispose()
  }

  async #ensure(target: ConnectTarget): Promise<RemoteConnection> {
    const live = this.#live
    if (live !== undefined && sameTarget(live.target, target)) return live.connection
    if (live !== undefined) this.disconnect()
    const connection = await this.#connect(target)
    this.#live = { target, connection }
    return connection
  }

  #requireLive(): RemoteConnection {
    const live = this.#live
    if (live === undefined) {
      throw new Error('还没有连接到远端：先完成一次「添加远端工作区」')
    }
    return live.connection
  }
}

function sameTarget(left: ConnectTarget, right: ConnectTarget): boolean {
  return left.distro === right.distro && left.port === right.port && left.remoteRoot === right.remoteRoot
}
