/**
 * 「添加工作区」的分阶段流程（宿主半）。
 *
 * 为什么要有 id + 轮询，而不是一个同步 POST：**取消**必须能在阶段之间生效。
 * 一个同步请求从探测跑到接入要几秒（远端 node 探测 + UNC stat），这期间浏览器
 * 只能干等，用户按不了取消。所以：`start()` 立刻回一个 running 快照，真正的
 * 工作在后台推进，浏览器按 id 轮询 `/flow`。
 *
 * 三个阶段（M1 的添加路径不启动 dsh，所以 bootstrap/launch/tunnel/barrier 不出现）：
 * - `probe`：校验来源与发行版是否存在；
 * - `verify`：读远端环境事实（node / glibc / tar / DSH_HOME）——只有 WSL 分支有；
 * - `attach`：把选中目录落成**本机真实路径**（本机路径原样，WSL 转 UNC 并实测可读）。
 *
 * 跳阶段是允许的（`enterPhase` 只禁止倒退），本机分支天然跳过 `verify`。
 */

import { win32 } from 'node:path'

import type { DistroInfo, FlowSnapshot, RemoteFacts, WorkspaceAddInput, WorkspaceRecord } from '../../shared/api.ts'
import {
  cancelFlow as cancelFlowState,
  completeFlow,
  enterPhase,
  failFlow,
  startFlow,
  type FlowError,
  type FlowState,
} from '../../shared/flow.ts'
import { isTeleportFailure } from '../backend/backend.ts'
import { TeleportError } from '../backend/errors.ts'
import { normalizeLocalPath } from './browse.ts'

/** 流程依赖；注入是为了让单测不碰真机（不 spawn、不 stat 真实路径）。 */
export interface WorkspaceAddDeps {
  readonly listDistros: () => Promise<readonly DistroInfo[]>
  readonly probeFacts: (distro: string, signal: AbortSignal | undefined) => Promise<RemoteFacts>
  readonly isDirectory: (path: string) => Promise<boolean>
  /** 把 distro 内路径转成候选 UNC（顺序即优先级）；注入以便断言「双候选都试过」。 */
  readonly uncCandidates: (distro: string, posixPath: string) => readonly string[]
}

/** 保留的最近快照数：够浏览器重连后补看，又不会无限涨。 */
const MAX_SNAPSHOTS = 8

/** 任意抛出物 → 跨进程可传的 `FlowError`。未知异常也要有码、有下一步（铁律 4）。 */
export function toFlowError(error: unknown): FlowError {
  if (isTeleportFailure(error)) {
    return {
      code: error.code,
      phase: error.phase,
      detail: error.detail,
      nextActions: [...error.nextActions],
      logTail: error.logTail,
    }
  }
  return {
    code: 'remote/unknown',
    phase: 'probe',
    detail: error instanceof Error ? error.message : String(error),
    nextActions: ['重试', '查看宿主日志'],
    logTail: '',
  }
}

function cancelledError(): TeleportError {
  return new TeleportError({
    code: 'remote/cancelled',
    detail: '用户取消了添加工作区',
    nextActions: ['重新添加'],
  })
}

/** 路径必须是绝对路径；相对路径在远端毫无意义（远端没有「当前目录」这个概念）。 */
export function assertAbsolute(source: string, path: string): void {
  const absolute = source === 'wsl' ? path.startsWith('/') : win32.isAbsolute(path)
  if (!absolute) {
    throw new TeleportError({
      code: 'remote/path-unreadable',
      detail: `${source} 的路径必须是绝对路径，收到 ${JSON.stringify(path)}`,
      nextActions: ['从目录浏览器里选择', '补全绝对路径后重试'],
    })
  }
}

export class WorkspaceFlows {
  readonly #deps: WorkspaceAddDeps
  readonly #snapshots = new Map<string, FlowSnapshot>()
  readonly #controllers = new Map<string, AbortController>()
  /**
   * 已被裁掉的 id。
   *
   * 光从表里 delete 不够：被裁的流程可能还在后台跑，它的下一次 publish 会把同一个 id
   * 重新写回表里，于是「裁掉」变成「复活」，长会话里表会重新涨回去。所以裁的时候记一笔，
   * 后台推进看到自己已死就闭嘴。
   */
  readonly #dropped = new Set<string>()
  #counter = 0

  constructor(deps: WorkspaceAddDeps) {
    this.#deps = deps
  }

  /** 发起一次添加；立刻返回 running 快照，后台推进。 */
  start(input: WorkspaceAddInput): FlowSnapshot {
    this.#counter += 1
    const id = `flow-${String(this.#counter)}`
    const controller = new AbortController()
    this.#controllers.set(id, controller)
    const snapshot: FlowSnapshot = { id, state: startFlow(), record: null }
    this.#snapshots.set(id, snapshot)
    void this.#run(id, input, controller)
    this.#trim()
    return snapshot
  }

  get(id: string): FlowSnapshot | undefined {
    return this.#snapshots.get(id)
  }

  /** 取消：只对仍在跑的流程生效（终态之后再取消是 no-op，不能把失败改写成取消）。 */
  cancel(id: string): FlowSnapshot | undefined {
    const snapshot = this.#snapshots.get(id)
    if (snapshot === undefined) return undefined
    const controller = this.#controllers.get(id)
    controller?.abort()
    const next: FlowSnapshot = { id, state: cancelFlowState(snapshot.state), record: snapshot.record }
    this.#snapshots.set(id, next)
    return next
  }

  /** 已完成、可交给 owner 的成果（新→旧）。 */
  records(): WorkspaceRecord[] {
    const found: WorkspaceRecord[] = []
    for (const snapshot of this.#snapshots.values()) {
      if (snapshot.record !== null) found.push(snapshot.record)
    }
    return found.reverse()
  }

  async #run(id: string, input: WorkspaceAddInput, controller: AbortController): Promise<void> {
    let state: FlowState = startFlow()
    const publish = (record: WorkspaceRecord | null): void => {
      if (this.#dropped.has(id)) return
      this.#snapshots.set(id, { id, state, record })
    }
    publish(null)
    try {
      const record = await this.#advance(input, controller.signal, (phase) => {
        state = enterPhase(state, phase)
        publish(null)
      })
      if (controller.signal.aborted) throw cancelledError()
      state = completeFlow(state)
      publish(record)
    } catch (error) {
      if (this.#dropped.has(id)) return
      const current = this.#snapshots.get(id)?.state ?? state
      const failed = failFlow(current, toFlowError(error))
      this.#snapshots.set(id, { id, state: failed, record: null })
    } finally {
      this.#controllers.delete(id)
    }
  }

  async #advance(
    input: WorkspaceAddInput,
    signal: AbortSignal,
    enter: (phase: 'probe' | 'verify' | 'attach') => void,
  ): Promise<WorkspaceRecord> {
    enter('probe')
    const check = (): void => {
      if (signal.aborted) throw cancelledError()
    }

    if (input.source === 'local') {
      const path = input.path
      if (path === undefined || path === '') {
        throw new TeleportError({
          code: 'remote/path-unreadable',
          detail: '本机目录没有给出路径',
          nextActions: ['从目录浏览器里选择一个目录'],
        })
      }
      assertAbsolute('local', path)
      enter('attach')
      const normalized = normalizeLocalPath(path)
      if (!(await this.#deps.isDirectory(normalized))) {
        throw new TeleportError({
          code: 'remote/path-unreadable',
          detail: `${normalized} 不是一个可读目录`,
          nextActions: ['换一个目录', '确认该目录存在且当前用户可读'],
        })
      }
      check()
      return { localPath: normalized, source: 'local', distro: null, posixPath: null, unc: null, remote: null }
    }

    if (input.source !== 'wsl') {
      throw new TeleportError({
        code: 'remote/platform-unsupported',
        detail: `${input.source} 后端计划在 M2/M5，M1 只实现本机与 WSL`,
        nextActions: ['改用本机目录或 WSL 发行版'],
      })
    }

    const distro = input.distro
    if (distro === undefined || distro === '') {
      throw new TeleportError({
        code: 'remote/platform-unsupported',
        detail: 'WSL 分支必须指定发行版',
        nextActions: ['从发行版列表里选一个'],
      })
    }
    const distros = await this.#deps.listDistros()
    check()
    if (!distros.some((entry) => entry.name === distro)) {
      throw new TeleportError({
        code: 'remote/platform-unsupported',
        detail: `本机没有名为 ${JSON.stringify(distro)} 的 WSL 发行版`,
        nextActions: ['刷新发行版列表', '在 Windows 上先安装该发行版'],
      })
    }

    enter('verify')
    const remote = await this.#deps.probeFacts(distro, signal)
    check()

    const posixPath = (input.path ?? '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/'
    assertAbsolute('wsl', posixPath)
    enter('attach')
    let chosen: string | undefined
    for (const candidate of this.#deps.uncCandidates(distro, posixPath)) {
      if (await this.#deps.isDirectory(candidate)) {
        chosen = candidate
        break
      }
    }
    check()
    if (chosen === undefined) {
      throw new TeleportError({
        code: 'remote/workspace-unwritable',
        detail: `${distro} 内的 ${posixPath} 无法以 UNC 形态读到（\\wsl.localhost 与 \\wsl$ 都试过）`,
        nextActions: ['确认该目录存在', '在 WSL 里执行 ls 检查权限', '重启 WSL 后重试'],
      })
    }
    return { localPath: chosen, source: 'wsl', distro, posixPath, unc: chosen, remote }
  }

  #trim(): void {
    while (this.#snapshots.size > MAX_SNAPSHOTS) {
      const oldest = this.#snapshots.keys().next()
      if (oldest.done === true) return
      this.#snapshots.delete(oldest.value)
      this.#dropped.add(oldest.value)
      this.#controllers.get(oldest.value)?.abort()
      this.#controllers.delete(oldest.value)
    }
  }
}
