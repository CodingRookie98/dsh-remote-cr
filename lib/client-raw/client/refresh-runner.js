"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRefreshRunner = createRefreshRunner;
function createRefreshRunner(deps) {
    let mine = null;
    const run = async () => {
        const before = deps.current();
        // 未连接：不发请求，也不算一次失败（否则断连期间退避会被白白推到 30 s）。
        if (before === null || before.connected !== true)
            return;
        try {
            const next = await deps.refresh();
            deps.applySnapshot(next);
            const owned = mine;
            deps.applyError((current) => (current === null || current === owned ? null : current));
            mine = null;
        }
        catch (caught) {
            const failure = deps.shape(caught);
            const previous = mine;
            mine = failure;
            deps.applyError((current) => (current === null || current === previous ? failure : current));
            const latest = deps.current();
            if (latest !== null && latest.attach === null) {
                try {
                    deps.applySnapshot(await deps.reread());
                }
                catch {
                    // 补读失败：保持旧帧；要报的是原来那条错误
                }
            }
            throw caught;
        }
    };
    return {
        run,
        get lastFailure() {
            return mine;
        },
    };
}
