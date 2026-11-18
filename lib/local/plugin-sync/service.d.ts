import { type RemoteRuntimePaths, type SyncExec } from './read.ts';
import { type HostPlan, type LocalBundle, type SyncEntry, type SyncResult } from '../../shared/plugin-sync.ts';
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
    /** 远端 dsh 检出根（WSL 必给）：同一次读取里顺带探明检出形态的运行时。 */
    readonly checkoutRoot?: string;
    /** staging 相对后缀（SSH 必给）：只认这台目标的目录，不扫别人的。 */
    readonly stagingSuffix?: string;
    /** 兜底解释器（检出形态）；真实值由读取脚本回报的 runtime 优先。 */
    readonly interpreter?: string | null;
    /** 本地宿主版本（决定「远端该升到哪个版本」）；读不出为 null。 */
    readonly hostVersion?: string | null;
    /** 引擎区间判定（注入 `dshSupported`），免得这一层依赖 SSH 引导器。 */
    readonly supported?: (version: string) => boolean;
    /**
     * 没有 runtime 就**不能**执行（WSL：dsh 只可能来自 staging 或检出，PATH 上没有）。
     * 为 true 时 `runtime === null` 直接给结构化错误，而不是拼一条必然 ENOENT 的命令。
     */
    readonly requiresRuntime?: boolean;
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
    /**
     * 同一次读取里探明的远端运行时。为 null = 远端没有可用的 dsh：面板据此禁用同步按钮并提示
     * 「先接入一次」，后端（`requiresRuntime`）据此拒绝执行。
     */
    readonly runtime: RemoteRuntimePaths | null;
    /**
     * 这个后端是否**必须**有 runtime 才能执行（WSL 为 true：PATH 上没有 dsh）。
     * 发给客户端是为了让 UI 与后端的判据**同一个条件**：SSH 远端若把 dsh 装在 PATH 上，
     * runtime 也是 null，但兜底的 `PATH='.':$PATH dsh` 其实是可用的，不该被 UI 误拦。
     */
    readonly requiresRuntime: boolean;
    /** 宿主版本对齐判定（H 系列）：只在 staging 形态下才可能是 `align`。 */
    readonly host: HostPlan;
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
    /** 计划里探明的远端运行时；缺了就用 backend 兜底（测试用）。 */
    readonly runtime?: RemoteRuntimePaths | null;
    readonly targetId: string;
    readonly entries: readonly SyncEntry[];
    readonly onResult?: (result: SyncResult) => void;
    readonly deadlineMs?: number;
}
/**
 * POST /plugin-sync 的内核：只接受 install 项；单条失败不影响其它条。
 *
 * 限流：与宿主升级共用一把锁（`locks.ts`）——两者写的是同一份 `<staging>/npm`，
 * 各管各的会让「升级中点同步」互相踩（R1-B1）。
 */
export declare function applySyncPlan(request: ApplyRequest): Promise<readonly SyncResult[]>;
/** 测试用：清掉并发锁（进程内状态在用例之间必须复位）。 */
export declare function resetApplyingForTest(): void;
//# sourceMappingURL=service.d.ts.map