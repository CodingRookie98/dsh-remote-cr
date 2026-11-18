import type { HostPlan, HostReasonId, SyncEntry, SyncResult, SyncReasonId } from '../shared/plugin-sync.ts';
import type { RemoteCrKey } from './locales.ts';
/**
 * 原因 id → 字典键的**类型化映射**（ADR-0007）。
 * 用 `as never` 拼键会让 tsc 失去保护，漏一个键只会在屏上印出 key。
 */
export declare const SYNC_REASON_KEYS: Readonly<Record<SyncReasonId, RemoteCrKey>>;
/** 宿主版本拒绝原因 → 字典键（同一手法：类型化，漏键 tsc 就报）。 */
export declare const HOST_REASON_KEYS: Readonly<Record<HostReasonId, RemoteCrKey>>;
/**
 * 同步对话框的**纯状态模型**（RFC-0003 需求① UI）。
 *
 * 为什么单独一层：对话框有 5 个状态、3 组列表、勾选集合与逐条结果，塞进组件里既难测
 * 也难在预览里复现。这里只做「收到什么事件 → 变成什么状态」，组件只负责画。
 */
/** 远端运行时（只用到「有没有」这一件事；字段本身是服务端的形状）。 */
export interface SyncRuntimeLike {
    readonly dshCommand: string;
}
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
    /**
     * 远端有没有可用的 dsh：`null` = 明确没有（staging 与检出都没有）→ 不许同步。
     * 字段缺省（旧宿主）时按「未知」放行，不拿一个不存在的门禁去拦老版本。
     */
    readonly runtime?: SyncRuntimeLike | null;
    /**
     * 服务端声明「这个后端必须有 runtime 才能执行」。与后端拒绝执行的条件**逐字一致**：
     * SSH 远端要是把 dsh 装在 PATH 上，runtime 同样是 null，但那条兜底命令是可用的。
     */
    readonly requiresRuntime?: boolean;
    /** 宿主版本对齐判定；字段缺省（旧宿主）时对话框不显示这一段。 */
    readonly host?: HostPlan;
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
/**
 * 把「一次接入的目标」翻成同步用的 target（审查 N1）。
 *
 * 为什么必须从**接入入参**取而不是读 snapshot：`openSyncDialog` 在 attach 之后立刻调用，
 * 此刻 `setSnapshot` 还没应用到本次渲染闭包 —— 读 snapshot 会拿到 null（首次接入）或
 * **上一台主机**（切换目标）。这里做成纯函数，接入路径与面板路径共用。
 */
export declare function syncTargetOf(target: {
    readonly backend: 'wsl' | 'ssh' | 'docker';
    readonly distro?: string | null;
    readonly alias?: string;
    readonly port: number;
    readonly remoteRoot: string;
}): {
    backend: 'ssh';
    alias: string;
    port: number;
    remoteRoot: string;
} | {
    backend: 'wsl';
    distro: string;
    port: number;
    remoteRoot: string;
} | null;
/** 远端没装 dsh 时不能同步：命令会指向一个不存在的入口（审查 B1）。 */
export declare function syncBlockedReason(plan: SyncPlanLike): 'no-runtime' | null;
/** 宿主版本这一行怎么画：null = 旧宿主没这个字段，不渲染（不拿不存在的门禁去拦老版本）。 */
export declare function hostPanelOf(plan: SyncPlanLike): HostPlan | null;
/** 给 UI 的分组：可同步 / 已最新 / 不可同步（跳过 + blocked + remote-newer）。 */
export declare function syncGroups(plan: SyncPlanLike): {
    readonly installable: readonly SyncEntry[];
    readonly upToDate: readonly SyncEntry[];
    readonly skipped: readonly SyncEntry[];
};
/**
 * 可复制的同步报告（done 态「复制日志」）。
 *
 * 只放**事实与码**：包名、动作、版本、结果、code/detail；不放远端路径（可能含用户名）。
 */
export declare function syncReport(state: SyncDialogState): string;
/** 成功/失败计数（done 态标题用）。 */
export declare function resultTotals(results: readonly SyncResult[]): {
    readonly ok: number;
    readonly failed: number;
};
//# sourceMappingURL=sync-state.d.ts.map