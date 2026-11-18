import type { SyncEntry, SyncResult } from '../shared/plugin-sync.ts'

/**
 * 同步对话框的**纯状态模型**（RFC-0003 需求① UI）。
 *
 * 为什么单独一层：对话框有 5 个状态、3 组列表、勾选集合与逐条结果，塞进组件里既难测
 * 也难在预览里复现。这里只做「收到什么事件 → 变成什么状态」，组件只负责画。
 */
export interface SyncPlanLike {
  readonly targetId: string
  readonly profile: string
  readonly entries: readonly SyncEntry[]
  readonly totals: { readonly install: number; readonly upToDate: number; readonly skipped: number }
  readonly muted: boolean
}

export interface FailureLikeShape {
  readonly code: string
  readonly detail: string
  readonly nextActions: readonly string[]
}

export type SyncDialogState =
  | { readonly phase: 'closed' }
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly plan: SyncPlanLike; readonly selected: readonly string[] }
  | {
      readonly phase: 'applying'
      readonly plan: SyncPlanLike
      readonly selected: readonly string[]
      readonly results: readonly SyncResult[]
    }
  | { readonly phase: 'done'; readonly plan: SyncPlanLike; readonly results: readonly SyncResult[] }
  | { readonly phase: 'failed'; readonly failure: FailureLikeShape }

export const CLOSED: SyncDialogState = { phase: 'closed' }

/** 打开对话框：进入 loading（数据随后由 receiveSyncPlan 填）。 */
export function openSync(): SyncDialogState {
  return { phase: 'loading' }
}

export function closeSync(): SyncDialogState {
  return CLOSED
}

export function failSync(failure: FailureLikeShape): SyncDialogState {
  return { phase: 'failed', failure }
}

/** 计划到达：默认全选「可同步」项（up-to-date / skip / blocked 不可选）。 */
export function receiveSyncPlan(plan: SyncPlanLike): SyncDialogState {
  const selected = plan.entries.filter((entry) => entry.action === 'install').map((entry) => entry.name)
  return { phase: 'ready', plan, selected }
}

export function toggleSyncEntry(state: SyncDialogState, name: string): SyncDialogState {
  if (state.phase !== 'ready') return state
  const has = state.selected.includes(name)
  const selected = has ? state.selected.filter((item) => item !== name) : [...state.selected, name]
  return { ...state, selected }
}

export function selectAllSync(state: SyncDialogState, select: boolean): SyncDialogState {
  if (state.phase !== 'ready') return state
  const installable = state.plan.entries.filter((entry) => entry.action === 'install').map((entry) => entry.name)
  return { ...state, selected: select ? installable : [] }
}

/** 开始执行：必须有选中项，否则原地不动（按钮层也会禁用，双保险）。 */
export function beginApply(state: SyncDialogState): SyncDialogState {
  if (state.phase !== 'ready' || state.selected.length === 0) return state
  return { phase: 'applying', plan: state.plan, selected: state.selected, results: [] }
}

export function receiveResult(state: SyncDialogState, result: SyncResult): SyncDialogState {
  if (state.phase !== 'applying') return state
  return { ...state, results: [...state.results, result] }
}

/** 执行结束：进入 done（无论成败，逐条结果都在 results 里）。 */
export function finishApply(state: SyncDialogState): SyncDialogState {
  if (state.phase !== 'applying') return state
  return { phase: 'done', plan: state.plan, results: state.results }
}

/** 给 UI 的分组：可同步 / 已最新 / 不可同步（跳过 + blocked + remote-newer）。 */
export function syncGroups(plan: SyncPlanLike): {
  readonly installable: readonly SyncEntry[]
  readonly upToDate: readonly SyncEntry[]
  readonly skipped: readonly SyncEntry[]
} {
  const installable = plan.entries.filter((entry) => entry.action === 'install')
  const upToDate = plan.entries.filter((entry) => entry.action === 'up-to-date')
  const skipped = plan.entries.filter((entry) => entry.action !== 'install' && entry.action !== 'up-to-date')
  return { installable, upToDate, skipped }
}

/** 成功/失败计数（done 态标题用）。 */
export function resultTotals(results: readonly SyncResult[]): { readonly ok: number; readonly failed: number } {
  let ok = 0
  for (const result of results) if (result.ok) ok += 1
  return { ok, failed: results.length - ok }
}
