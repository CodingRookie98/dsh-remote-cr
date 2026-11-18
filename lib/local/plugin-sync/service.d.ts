import { type SyncExec } from './read.ts';
import { type LocalBundle, type SyncEntry, type SyncResult } from '../../shared/plugin-sync.ts';
/**
 * 同步的路由级编排（RFC-0003 / T4 的内核）。
 *
 * 这里只做「取数 → 差集 → 执行 → 聚合」，I/O 全部由注入的 backend 提供，
 * 因此可以在单测里用假 exec 跑完整链路，不用起真远端。
 */
export interface SyncBackend {
    readonly exec: SyncExec;
    /** 远端 node 可执行描述（绝对路径或 'node'）。 */
    readonly nodeCommand: string;
    /** 远端 dsh 入口绝对路径。 */
    readonly dshCommand: string;
    /** 远端 node 的 bin 目录（PATH 前缀）。 */
    readonly nodeBin: string;
    /** 远端 home（定位 profile）。 */
    readonly homeDir: string;
    readonly profile?: string;
}
export interface SyncPlanView {
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
export interface PlanRequest {
    readonly backend: SyncBackend;
    readonly targetId: string;
    readonly local: readonly LocalBundle[];
    readonly muted: boolean;
    readonly deadlineMs?: number;
}
/** GET /plugin-sync 的内核：远端只读一次，不写任何东西。 */
export declare function buildSyncPlan(request: PlanRequest): Promise<SyncPlanView>;
export interface ApplyRequest {
    readonly backend: SyncBackend;
    readonly targetId: string;
    readonly entries: readonly SyncEntry[];
    readonly onResult?: (result: SyncResult) => void;
    readonly deadlineMs?: number;
}
export declare function applySyncPlan(request: ApplyRequest): Promise<readonly SyncResult[]>;
/** 测试用：清掉并发锁（进程内状态在用例之间必须复位）。 */
export declare function resetApplyingForTest(): void;
//# sourceMappingURL=service.d.ts.map