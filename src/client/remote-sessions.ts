import type { ProjectionSnapshotInfo } from '../shared/api.ts'
import { readProjection } from './api.ts'

/**
 * 远端会话索引（RFC-0003 需求② / R2-3、R2-4）。
 *
 * 为什么需要独立索引：会话行徽标挂在 **DSH 自己的侧栏**上，而侧栏在面板没打开时也要正确。
 * 面板的投影是组件内 state（打开才拉），不能作为徽标的数据源；这里做一个模块级索引，
 * 面板与会话行共用同一份事实。
 *
 * 失败策略：刷新失败**保留上一次的快照**（网络抖一下不该让徽标集体消失），只通知订阅者。
 */
export interface RemoteSessionIndex {
  has(sessionId: string): boolean
  /** 该会话属于哪个远端工作区（菜单项要用它判断「是不是远端会话」）。 */
  workspaceOf(sessionId: string): string | null
  hasWorkspace(workspaceId: string): boolean
  readonly size: number
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
}

export function createRemoteSessionIndex(load: () => Promise<ProjectionSnapshotInfo>): RemoteSessionIndex {
  const sessionWorkspace = new Map<string, string>()
  let sessions = new Set<string>()
  let workspaces = new Set<string>()
  const listeners = new Set<() => void>()
  let inFlight: Promise<void> | null = null

  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }

  return {
    get size() {
      return sessions.size
    },
    has(sessionId: string) {
      return sessions.has(sessionId)
    },
    workspaceOf(sessionId: string) {
      return sessionWorkspace.get(sessionId) ?? null
    },
    hasWorkspace(workspaceId: string) {
      return workspaces.has(workspaceId)
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh() {
      if (inFlight !== null) return inFlight
      inFlight = (async () => {
        try {
          const snapshot = await load()
          sessionWorkspace.clear()
          for (const session of snapshot.sessions) sessionWorkspace.set(session.sessionId, session.workspaceId)
          sessions = new Set(snapshot.sessions.map((session) => session.sessionId))
          workspaces = new Set(snapshot.workspaces.map((workspace) => workspace.id))
          notify()
        } catch {
          // 保留旧快照：宁可用上一次的事实，也不要让徽标闪没。
        } finally {
          inFlight = null
        }
      })()
      return inFlight
    },
  }
}

/** 进程内单例：面板与侧栏徽标共用。 */
export const remoteSessionIndex: RemoteSessionIndex = createRemoteSessionIndex(() => readProjection())
