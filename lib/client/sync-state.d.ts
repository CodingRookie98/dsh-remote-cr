import type { SyncEntry, SyncResult, SyncReasonId } from '../shared/plugin-sync.ts';
import type { RemoteCrKey } from './locales.ts';
/**
 * 原因 id → 字典键的**类型化映射**（ADR-0007）。
 * 用 `as never` 拼键会让 tsc 失去保护，漏一个键只会在屏上印出 key。
 */
export declare const SYNC_REASON_KEYS: Readonly<Record<SyncReasonId, RemoteCrKey>>;
/**
 * 同步对话框的**纯状态模型**（RFC-0003 需求① UI）。
 *
 * 为什么单独一层：对话框有 5 个状态、3 组列表、勾选集合与逐条结果，塞进组件里既难测
 * 也难在预览里复现。这里只做「收到什么事件 → 变成什么状态」，组件只负责画。
 */
export interface SyncPlanLike {
    readonly targetId: string;
    readonly profile: string;
    readonly entries: readonly SyncEntry[];
    readonly totals: {
        readonly install: number;
        readonly upToDate: number;
        readonly skipped: number;
    };
    readonly muted: boolean;
}
export interface FailureLikeShape {
    readonly code: string;
    readonly detail: string;
    readonly nextActions: readonly string[];
}
export type SyncDialogState = {
    readonly phase: 'closed';
} | {
    readonly phase: 'loading';
} | {
    readonly phase: 'ready';
    readonly plan: SyncPlanLike;
    readonly selected: readonly string[];
} | {
    readonly phase: 'applying';
    readonly plan: SyncPlanLike;
    readonly selected: readonly string[];
    readonly results: readonly SyncResult[];
} | {
    readonly phase: 'done';
    readonly plan: SyncPlanLike;
    readonly results: readonly SyncResult[];
} | {
    readonly phase: 'failed';
    readonly failure: FailureLikeShape;
};
export declare const CLOSED: SyncDialogState;
/** 打开对话框：进入 loading（数据随后由 receiveSyncPlan 填）。 */
export declare function openSync(): SyncDialogState;
export declare function closeSync(): SyncDialogState;
export declare function failSync(failure: FailureLikeShape): SyncDialogState;
/** 计划到达：默认全选「可同步」项（up-to-date / skip / blocked 不可选）。 */
export declare function receiveSyncPlan(plan: SyncPlanLike): SyncDialogState;
export declare function toggleSyncEntry(state: SyncDialogState, name: string): SyncDialogState;
export declare function selectAllSync(state: SyncDialogState, select: boolean): SyncDialogState;
/** 开始执行：必须有选中项，否则原地不动（按钮层也会禁用，双保险）。 */
export declare function beginApply(state: SyncDialogState): SyncDialogState;
export declare function receiveResult(state: SyncDialogState, result: SyncResult): SyncDialogState;
/** 执行结束：进入 done（无论成败，逐条结果都在 results 里）。 */
export declare function finishApply(state: SyncDialogState): SyncDialogState;
/** 给 UI 的分组：可同步 / 已最新 / 不可同步（跳过 + blocked + remote-newer）。 */
export declare function syncGroups(plan: SyncPlanLike): {
    readonly installable: readonly SyncEntry[];
    readonly upToDate: readonly SyncEntry[];
    readonly skipped: readonly SyncEntry[];
};
/** 成功/失败计数（done 态标题用）。 */
export declare function resultTotals(results: readonly SyncResult[]): {
    readonly ok: number;
    readonly failed: number;
};
//# sourceMappingURL=sync-state.d.ts.map