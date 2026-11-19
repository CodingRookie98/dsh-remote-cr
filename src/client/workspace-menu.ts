/**
 * 侧栏「工作区行 ⋯ 菜单」里的远端条目。
 *
 * 上游没有「工作区行」的 slot hole（见 `docs/proposals/upstream-workspace-row-holes.md`），
 * 但它把所有行菜单都收敛到了 `ctx.contextMenus`（`target.kind === 'workspace'`）。
 * 于是「重新连接 / 断开 / 结束远端」可以**不改上游**地落进那个 ⋯ 菜单：
 * 只有当我们认得这个工作是远端投影时才返回动作，否则返回空数组 ——
 * 官方菜单与别的插件的贡献完全不受影响（注册表按 target 隔离）。
 *
 * 与 `registration.ts` 的分工：这里只算「该有哪些动作」与「点了做什么」，
 * 注册与生命周期由调用方用 `ctx.effect` 管。
 */

import type { RemoteTargetInfo } from '../shared/api.ts'

/** 上游 `ContextMenuTargetMap` 里 workspace 那一支的结构（只取本模块用到的字段）。 */
export interface WorkspaceMenuTarget {
  readonly workspaceId: string
  readonly path: string
  readonly displayTitle: string
}

/** 一条菜单动作（上游 `MenuAction` 的子集）。 */
export interface WorkspaceMenuAction {
  readonly id: string
  readonly label: string
  readonly disabled?: boolean
  readonly danger?: boolean
  readonly separatorBefore?: boolean
  readonly failureLabel?: string
  readonly run?: () => void | Promise<void>
}

/** 上游 `ContextMenus` 服务里本模块用到的那一个方法。 */
export interface ContextMenusFace {
  register(contribution: {
    readonly id: string
    readonly target: 'workspace'
    readonly order: number
    resolve(
      target: WorkspaceMenuTarget,
      signal: AbortSignal,
    ): readonly WorkspaceMenuAction[] | Promise<readonly WorkspaceMenuAction[]>
  }): () => void
}

/** 判定一个工作区是不是我们的：投影表里有它，且知道它属于哪台远端。 */
export interface WorkspaceMenuSnapshot {
  readonly connected: boolean
  readonly target: RemoteTargetInfo | null
  readonly workspaces: readonly { readonly localPath: string }[]
}

/** 动作文案（调用方从字典取，本模块不碰 i18n，方便单测）。 */
export interface WorkspaceMenuLabels {
  readonly reconnect: string
  readonly disconnect: string
  readonly stop: string
}

/** 点了要做什么。`target` 是**那台远端**，不是全局 focus。 */
export interface WorkspaceMenuHandlers {
  readonly reconnect: (target: RemoteTargetInfo) => Promise<unknown>
  readonly disconnect: (target: RemoteTargetInfo) => Promise<unknown>
  readonly stop: (target: RemoteTargetInfo) => Promise<unknown>
}

/**
 * 从快照推出这个工作区的菜单动作。
 *
 * 纯函数：`snapshot === null`（还没读到投影）、`target === null`（没连过）、
 * 或投影表里没有这个路径，都返回 `[]` —— 在别人的工作区上不该出现我们的项。
 * 顺序固定：重连 → 断开 → 结束远端（危险项带分隔线，排在最后）。
 */
export function workspaceMenuActions(
  workspace: WorkspaceMenuTarget,
  snapshot: WorkspaceMenuSnapshot | null,
  labels: WorkspaceMenuLabels,
  handlers: WorkspaceMenuHandlers,
): readonly WorkspaceMenuAction[] {
  if (snapshot === null) return []
  const target = snapshot.target
  if (target === null) return []
  const known = snapshot.workspaces.some((entry) => entry.localPath === workspace.path)
  if (!known) return []
  const actions: WorkspaceMenuAction[] = [
    {
      id: 'remote-cr.reconnect',
      label: labels.reconnect,
      failureLabel: labels.reconnect,
      run: async () => {
        await handlers.reconnect(target)
      },
    },
  ]
  if (snapshot.connected) {
    actions.push({
      id: 'remote-cr.disconnect',
      label: labels.disconnect,
      failureLabel: labels.disconnect,
      run: async () => {
        await handlers.disconnect(target)
      },
    })
  }
  actions.push({
    id: 'remote-cr.stop',
    label: labels.stop,
    danger: true,
    separatorBefore: true,
    failureLabel: labels.stop,
    run: async () => {
      await handlers.stop(target)
    },
  })
  return actions
}

/** 注册用的贡献体：`resolve` 里现读一次投影（行菜单打开是低频动作，值得这次往返）。 */
export function workspaceMenuContribution(deps: {
  readonly snapshot: () => Promise<WorkspaceMenuSnapshot | null>
  readonly labels: WorkspaceMenuLabels
  readonly handlers: WorkspaceMenuHandlers
}): {
  readonly id: string
  readonly target: 'workspace'
  readonly order: number
  resolve(target: WorkspaceMenuTarget): Promise<readonly WorkspaceMenuAction[]>
} {
  return {
    id: 'remote-cr.workspace',
    target: 'workspace',
    // 排在官方三项（重命名/在文件夹显示/删除工作区，order 100 起）之后。
    order: 500,
    async resolve(target: WorkspaceMenuTarget): Promise<readonly WorkspaceMenuAction[]> {
      try {
        const snapshot = await deps.snapshot()
        return workspaceMenuActions(target, snapshot, deps.labels, deps.handlers)
      } catch {
        // 读投影失败（远端断线）不是菜单的错误：静默不给项，用户还有面板可用。
        return []
      }
    },
  }
}
