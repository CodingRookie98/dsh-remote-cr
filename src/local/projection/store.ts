/**
 * 远端工作区与会话的**只读投影**（宿主半的内存表）。
 *
 * 依据 `docs/design/architecture.md` §4.2：本地保存远端会话的只读投影（标题、状态、
 * 时间、摘要），操作转发到远端；**不双写**，以远端为准；断连时投影标
 * `sourceAvailability = "offline"`。
 *
 * 为什么是内存表而不是持久化：M1 的口径是「以远端为准」，本地这份只是**呈现缓存**。
 * 持久化会把「远端已删、本地还在」变成常态，而这正是 §4.2 明令禁止的双写。
 * 断连后重连时整表按远端快照重建即可（`replaceAll`）。
 *
 * 三条纪律（都有单测）：
 * 1. **容量有界**：远端有上千个会话时，投影不能跟着无限涨；
 * 2. **offline 是状态不是删除**：断连后条目留着、标 offline，用户才能看到「它还在」；
 * 3. **不猜**：远端没给的字段保持 undefined，不用本地时钟编造时间戳。
 */

/** 远端条目的可用性；与 `architecture.md` §8.2 的状态口径一致。 */
export type SourceAvailability = 'online' | 'offline'

/** 一个被投影的远端工作区。 */
export interface ProjectedWorkspace {
  /** 远端宿主上的工作区 id（远端注册表给的，不是本地编的）。 */
  readonly id: string
  /** 注册给本地 DSH 的路径：WSL 为 UNC，将来锚点后端为本地锚点目录。 */
  readonly localPath: string
  /** 远端真实路径（WSL 为 distro 内 POSIX 路径）；未知时为 null。 */
  readonly remotePath: string | null
  readonly backend: 'wsl' | 'ssh' | 'docker'
  readonly distro: string | null
  readonly title: string
  readonly availability: SourceAvailability
}

/** 一个被投影的远端会话（只读摘要，不含消息正文）。 */
export interface ProjectedSession {
  readonly sessionId: string
  readonly workspaceId: string
  readonly title: string
  readonly updatedAt: string | undefined
  readonly availability: SourceAvailability
}

/** 单表容量上限：够用户翻，又不会把内存交给远端。 */
export const MAX_PROJECTED_WORKSPACES = 64
export const MAX_PROJECTED_SESSIONS = 512

/**
 * 投影表。
 *
 * 全部方法都是**整体替换语义**（upsert / replaceAll），没有「合并远端增量」——
 * 增量合并需要版本号或墓碑，远端目前都不给，硬做只会得到「删不掉」的幽灵条目。
 */
export class ProjectionStore {
  readonly #workspaces = new Map<string, ProjectedWorkspace>()
  readonly #sessions = new Map<string, ProjectedSession>()

  /** 写入/更新一个工作区；超出容量时按**插入顺序**丢最旧的。 */
  upsertWorkspace(workspace: ProjectedWorkspace): void {
    // 先删再插：Map 保持插入顺序，重插等于把这条挪到最新，淘汰顺序才符合「最久未更新」。
    this.#workspaces.delete(workspace.id)
    this.#workspaces.set(workspace.id, workspace)
    while (this.#workspaces.size > MAX_PROJECTED_WORKSPACES) {
      const oldest = this.#workspaces.keys().next()
      if (oldest.done === true) break
      this.#workspaces.delete(oldest.value)
    }
  }

  upsertSession(session: ProjectedSession): void {
    this.#sessions.delete(session.sessionId)
    this.#sessions.set(session.sessionId, session)
    while (this.#sessions.size > MAX_PROJECTED_SESSIONS) {
      const oldest = this.#sessions.keys().next()
      if (oldest.done === true) break
      this.#sessions.delete(oldest.value)
    }
  }

  /** 按远端快照整体重建；远端是唯一真相源，本地不留远端已经删掉的条目。 */
  replaceAll(workspaces: readonly ProjectedWorkspace[], sessions: readonly ProjectedSession[]): void {
    this.#workspaces.clear()
    this.#sessions.clear()
    for (const workspace of workspaces) this.upsertWorkspace(workspace)
    for (const session of sessions) this.upsertSession(session)
  }

  /**
   * 断连：**只改状态、不删条目**。
   *
   * 删掉的话用户会以为远端工作区没了；而 A7 要求「断线后工作区状态可见」。
   */
  markAllOffline(): void {
    for (const [id, workspace] of this.#workspaces) {
      if (workspace.availability === 'offline') continue
      this.#workspaces.set(id, { ...workspace, availability: 'offline' })
    }
    for (const [id, session] of this.#sessions) {
      if (session.availability === 'offline') continue
      this.#sessions.set(id, { ...session, availability: 'offline' })
    }
  }

  /** 新→旧：面板按最近打开的排前面（`ui-design.md` §3）。 */
  workspaces(): ProjectedWorkspace[] {
    return [...this.#workspaces.values()].reverse()
  }

  /** 某个工作区下的会话，新→旧。 */
  sessions(workspaceId: string): ProjectedSession[] {
    return [...this.#sessions.values()].filter((session) => session.workspaceId === workspaceId).reverse()
  }

  get size(): { readonly workspaces: number; readonly sessions: number } {
    return { workspaces: this.#workspaces.size, sessions: this.#sessions.size }
  }
}
