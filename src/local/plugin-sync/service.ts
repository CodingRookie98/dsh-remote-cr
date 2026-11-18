import { RemoteCrError } from '../backend/errors.ts'
import { applySync } from './apply.ts'
import { readRemoteProfile, type RemoteRuntimePaths, type SyncExec } from './read.ts'
import { diffBundles, planTotals, type LocalBundle, type SyncEntry, type SyncResult } from '../../shared/plugin-sync.ts'

/**
 * 同步的路由级编排（RFC-0003 / T4 的内核）。
 *
 * 这里只做「取数 → 差集 → 执行 → 聚合」，I/O 全部由注入的 backend 提供，
 * 因此可以在单测里用假 exec 跑完整链路，不用起真远端。
 */
export interface SyncBackend {
  readonly exec: SyncExec
  /** 远端 node 可执行描述（绝对路径或 'node'）。 */
  readonly nodeCommand: string
  /** 远端 dsh 入口绝对路径。 */
  readonly dshCommand: string
  /** 远端 node 的 bin 目录（PATH 前缀）。 */
  readonly nodeBin: string
  /** 远端 home（定位 profile）。 */
  readonly homeDir: string
  readonly profile?: string
}

export interface SyncPlanView {
  readonly targetId: string
  readonly profile: string
  readonly entries: readonly SyncEntry[]
  readonly totals: { readonly install: number; readonly upToDate: number; readonly skipped: number }
  readonly muted: boolean
  /** 同一次读取里探明的远端运行时；为 null 时前端应提示「先接入一次」而不是给同步按钮。 */
  readonly runtime: RemoteRuntimePaths | null
}

export interface PlanRequest {
  readonly backend: SyncBackend
  readonly targetId: string
  readonly local: readonly LocalBundle[]
  readonly muted: boolean
  readonly deadlineMs?: number
}

/** GET /plugin-sync 的内核：远端只读一次，不写任何东西。 */
export async function buildSyncPlan(request: PlanRequest): Promise<SyncPlanView> {
  const profile = request.backend.profile ?? 'web'
  const remote = await readRemoteProfile({
    exec: request.backend.exec,
    nodeCommand: request.backend.nodeCommand,
    homeDir: request.backend.homeDir,
    profile,
    ...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }),
  })
  const entries = diffBundles({ local: request.local, remote: remote.bundles })
  return {
    targetId: request.targetId,
    profile,
    entries,
    totals: planTotals(entries),
    muted: request.muted,
    runtime: remote.runtime,
  }
}

export interface ApplyRequest {
  readonly backend: SyncBackend
  /** 计划里探明的远端运行时；缺了就用 backend 兜底（测试用）。 */
  readonly runtime?: RemoteRuntimePaths | null
  readonly targetId: string
  readonly entries: readonly SyncEntry[]
  readonly onResult?: (result: SyncResult) => void
  readonly deadlineMs?: number
}

/**
 * POST /plugin-sync 的内核：只接受 install 项；单条失败不影响其它条。
 *
 * 限流：同一 target 同时只允许一次执行 —— 并发执行会让 pnpm 在同一 profile 上互相踩。
 */
const applying = new Set<string>()

export async function applySyncPlan(request: ApplyRequest): Promise<readonly SyncResult[]> {
  if (applying.has(request.targetId)) {
    throw new RemoteCrError({
      code: 'remote/plugin-sync-unsupported',
      detail: '这台远端已经在同步中',
      nextActions: ['等当前同步结束', '或先关闭同步面板'],
    })
  }
  applying.add(request.targetId)
  try {
    const runtime = request.runtime ?? null
    return await applySync({
      entries: request.entries,
      exec: request.backend.exec,
      dshCommand: runtime?.dshCommand ?? request.backend.dshCommand,
      nodeBin: runtime?.nodeBin ?? request.backend.nodeBin,
      profile: request.backend.profile ?? 'web',
      ...(request.onResult === undefined ? {} : { onResult: request.onResult }),
      ...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }),
    })
  } finally {
    applying.delete(request.targetId)
  }
}

/** 测试用：清掉并发锁（进程内状态在用例之间必须复位）。 */
export function resetApplyingForTest(): void {
  applying.clear()
}
