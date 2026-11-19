import type { HostPlan, HostReasonId, SyncEntry, SyncResult, SyncReasonId } from '../shared/plugin-sync.ts'
import type { RemoteCrKey } from './locales.ts'

/**
 * 原因 id → 字典键的**类型化映射**（ADR-0007）。
 * 用 `as never` 拼键会让 tsc 失去保护，漏一个键只会在屏上印出 key。
 */
export const SYNC_REASON_KEYS: Readonly<Record<SyncReasonId, RemoteCrKey>> = {
  none: 'syncReason.none',
  'missing-remote': 'syncReason.missing-remote',
  'remote-older': 'syncReason.remote-older',
  'remote-newer': 'syncReason.remote-newer',
  'local-path-plugin': 'syncReason.local-path-plugin',
  'local-version-unknown': 'syncReason.local-version-unknown',
}

/** 宿主版本拒绝原因 → 字典键（同一手法：类型化，漏键 tsc 就报）。 */
export const HOST_REASON_KEYS: Readonly<Record<HostReasonId, RemoteCrKey>> = {
  none: 'sync.host.upToDate',
  'checkout-mode': 'syncHostReason.checkout-mode',
  'source-unknown': 'syncHostReason.source-unknown',
  'local-version-unknown': 'syncHostReason.local-version-unknown',
  'out-of-range': 'syncHostReason.out-of-range',
  'remote-version-unknown': 'syncHostReason.remote-version-unknown',
}

/**
 * 同步对话框的**纯状态模型**（RFC-0003 需求① UI）。
 *
 * 为什么单独一层：对话框有 5 个状态、3 组列表、勾选集合与逐条结果，塞进组件里既难测
 * 也难在预览里复现。这里只做「收到什么事件 → 变成什么状态」，组件只负责画。
 */
/** 远端运行时（只用到「有没有」这一件事；字段本身是服务端的形状）。 */
export interface SyncRuntimeLike {
  readonly dshCommand: string
}

export interface SyncPlanLike {
  readonly targetId: string
  readonly profile: string
  readonly entries: readonly SyncEntry[]
  readonly totals: { readonly install: number; readonly upToDate: number; readonly skipped: number }
  readonly muted: boolean
  /**
   * 远端有没有可用的 dsh：`null` = 明确没有（staging 与检出都没有）→ 不许同步。
   * 字段缺省（旧宿主）时按「未知」放行，不拿一个不存在的门禁去拦老版本。
   */
  readonly runtime?: SyncRuntimeLike | null
  /**
   * 服务端声明「这个后端必须有 runtime 才能执行」。与后端拒绝执行的条件**逐字一致**：
   * SSH 远端要是把 dsh 装在 PATH 上，runtime 同样是 null，但那条兜底命令是可用的。
   */
  readonly requiresRuntime?: boolean
  /** 宿主版本对齐判定；字段缺省（旧宿主）时对话框不显示这一段。 */
  readonly host?: HostPlan
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

/**
 * 把「一次接入的目标」翻成同步用的 target（审查 N1）。
 *
 * 为什么必须从**接入入参**取而不是读 snapshot：`openSyncDialog` 在 attach 之后立刻调用，
 * 此刻 `setSnapshot` 还没应用到本次渲染闭包 —— 读 snapshot 会拿到 null（首次接入）或
 * **上一台主机**（切换目标）。这里做成纯函数，接入路径与面板路径共用。
 */
export function syncTargetOf(target: {
  readonly backend: 'wsl' | 'ssh' | 'docker'
  readonly distro?: string | null
  readonly alias?: string
  readonly port: number
  readonly remoteRoot: string
}): { backend: 'ssh'; alias: string; port: number; remoteRoot: string } | { backend: 'wsl'; distro: string; port: number; remoteRoot: string } | null {
  if (target.backend === 'ssh') {
    const alias = target.alias ?? ''
    return alias === '' ? null : { backend: 'ssh', alias, port: target.port, remoteRoot: target.remoteRoot }
  }
  if (target.backend === 'wsl') {
    const distro = target.distro ?? ''
    return distro === '' ? null : { backend: 'wsl', distro, port: target.port, remoteRoot: target.remoteRoot }
  }
  return null
}

/** 远端没装 dsh 时不能同步：命令会指向一个不存在的入口（审查 B1）。 */
export function syncBlockedReason(plan: SyncPlanLike): 'no-runtime' | null {
  // 条件必须与 `applySyncPlan` 的后端门禁同形（runtime 为空 **且** 该后端必须有 runtime），
  // 否则 SSH（dsh 在 PATH 上时 runtime 也是 null）会被 UI 误拦。字段缺省 = 老宿主 = 不拦。
  return plan.runtime === null && plan.requiresRuntime === true ? 'no-runtime' : null
}

/**
 * 失败面的「可照抄」两件东西：命令与远端原文。
 *
 * 为什么单独抽出来：`localizeFailure` 会把 nextActions 换成本地化字典文案（`errNext.*`），
 * 精确命令（含 staging 路径）与 npm 原文只能靠这两个字段原样呈现（2026-11-18 R1 BLK-4）。
 * 空串一律折成 null：渲染层据此决定要不要画那块，而不是画一个空白框。
 */
export function hostFailureExtras(failure: { readonly command?: string | null; readonly logTail?: string | null }): {
  readonly command: string | null
  readonly logTail: string | null
} {
  const clean = (value: string | null | undefined): string | null => {
    if (value === null || value === undefined) return null
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }
  return { command: clean(failure.command), logTail: clean(failure.logTail) }
}

/**
 * 首次接入要不要自动弹同步对话框（R2-S12：这条需求原本零覆盖）。
 *
 * 只有「有可同步项」且「这台没被静音」才打扰用户；静音后手动入口仍然可用（由 UI 保证）。
 */
export function shouldAutoOpenSync(plan: { readonly muted: boolean; readonly totals: { readonly install: number } }): boolean {
  return !plan.muted && plan.totals.install > 0
}

/** 宿主版本这一行怎么画：null = 旧宿主没这个字段，不渲染（不拿不存在的门禁去拦老版本）。 */
export function hostPanelOf(plan: SyncPlanLike): HostPlan | null {
  return plan.host ?? null
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

/**
 * 可复制的同步报告（done 态「复制日志」）。
 *
 * 只放**事实与码**：包名、动作、版本、结果、code/detail；不放远端路径（可能含用户名）。
 */
export function syncReport(state: SyncDialogState): string {
  if (state.phase !== 'done' && state.phase !== 'applying') return ''
  const lines = [
    'dsh-remote-cr plugin sync',
    'profile: ' + state.plan.profile,
    'target: ' + state.plan.targetId,
    'results: ' + String(state.results.length),
  ]
  for (const result of state.results) {
    lines.push(
      (result.ok ? 'ok   ' : 'FAIL ') +
        result.name +
        (result.ok ? '' : ' ' + (result.code ?? '') + (result.detail === undefined ? '' : ' — ' + result.detail)),
    )
  }
  return lines.join('\n')
}

/** 成功/失败计数（done 态标题用）。 */
export function resultTotals(results: readonly SyncResult[]): { readonly ok: number; readonly failed: number } {
  let ok = 0
  for (const result of results) if (result.ok) ok += 1
  return { ok, failed: results.length - ok }
}
