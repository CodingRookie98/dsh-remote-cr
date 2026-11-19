/**
 * 后台刷新的**执行体**（P4 B1 的补救：把失败链从 React 里搬出来，才测得住）。
 *
 * 之前这段逻辑写在 `panel-view.ts` 的 `refreshOnce` 里，后果是：把失败分支改成 `setSnapshot(null)`
 * （正是 R1 明令禁止的「失败清表」）全套 837 个测试仍然是绿的——注释里写着三条纪律，一行都没有断言。
 *
 * 三条纪律（每条都有用例）：
 * 1. **失败不清表**：失败路径绝不调用 `applySnapshot`；旧帧由宿主保留，客户端也不许自己抹掉；
 * 2. **失败后补读**：`/projection` 是纯本地读，失败时立刻读一次拿宿主的 `stale=true`，
 *    否则徽标要等下一轮退避（10–30 s）才亮；attach 进行中不补读（那会与 `settleSnapshot` 的每 100 ms 写入抢方向盘）；
 * 3. **只撤自己的错误**：成功时只清掉「本执行体自己写进去的那一条」，不误伤 probe / 建会话的错误；
 *    失败时也不覆盖别人已有的错误（否则用户手上的「重试」会从重放原动作变成踢调度器）。
 */
import type { ProjectionSnapshotInfo } from '../shared/api.ts';
/** 执行体需要的全部外部能力（都注入，才能用假对象把三条纪律钉死）。 */
export interface RefreshRunnerDeps<F> {
    /** 当前面板快照（可能为 null，或仍是上一帧）。 */
    readonly current: () => ProjectionSnapshotInfo | null;
    /** 打一次刷新（POST /projection/refresh）。 */
    readonly refresh: () => Promise<ProjectionSnapshotInfo>;
    /** 读一次宿主快照（纯本地，不触发远端 RPC）。 */
    readonly reread: () => Promise<ProjectionSnapshotInfo>;
    readonly applySnapshot: (snapshot: ProjectionSnapshotInfo) => void;
    /** 与 React 的 `setError` 同形：接收 updater，保证「按身份撤」这件事可测。 */
    readonly applyError: (update: (current: F | null) => F | null) => void;
    readonly shape: (caught: unknown) => F;
}
export interface RefreshRunner<F> {
    /** 跑一次；失败时**原样抛出**（退避由调度器结算）。 */
    run(): Promise<void>;
    /** 本执行体自己写进去的那条错误（成功即清空）。 */
    readonly lastFailure: F | null;
}
export declare function createRefreshRunner<F>(deps: RefreshRunnerDeps<F>): RefreshRunner<F>;
