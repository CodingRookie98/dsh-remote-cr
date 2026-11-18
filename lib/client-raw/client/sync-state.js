"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CLOSED = void 0;
exports.openSync = openSync;
exports.closeSync = closeSync;
exports.failSync = failSync;
exports.receiveSyncPlan = receiveSyncPlan;
exports.toggleSyncEntry = toggleSyncEntry;
exports.selectAllSync = selectAllSync;
exports.beginApply = beginApply;
exports.receiveResult = receiveResult;
exports.finishApply = finishApply;
exports.syncGroups = syncGroups;
exports.resultTotals = resultTotals;
exports.CLOSED = { phase: 'closed' };
/** 打开对话框：进入 loading（数据随后由 receiveSyncPlan 填）。 */
function openSync() {
    return { phase: 'loading' };
}
function closeSync() {
    return exports.CLOSED;
}
function failSync(failure) {
    return { phase: 'failed', failure };
}
/** 计划到达：默认全选「可同步」项（up-to-date / skip / blocked 不可选）。 */
function receiveSyncPlan(plan) {
    const selected = plan.entries.filter((entry) => entry.action === 'install').map((entry) => entry.name);
    return { phase: 'ready', plan, selected };
}
function toggleSyncEntry(state, name) {
    if (state.phase !== 'ready')
        return state;
    const has = state.selected.includes(name);
    const selected = has ? state.selected.filter((item) => item !== name) : [...state.selected, name];
    return { ...state, selected };
}
function selectAllSync(state, select) {
    if (state.phase !== 'ready')
        return state;
    const installable = state.plan.entries.filter((entry) => entry.action === 'install').map((entry) => entry.name);
    return { ...state, selected: select ? installable : [] };
}
/** 开始执行：必须有选中项，否则原地不动（按钮层也会禁用，双保险）。 */
function beginApply(state) {
    if (state.phase !== 'ready' || state.selected.length === 0)
        return state;
    return { phase: 'applying', plan: state.plan, selected: state.selected, results: [] };
}
function receiveResult(state, result) {
    if (state.phase !== 'applying')
        return state;
    return { ...state, results: [...state.results, result] };
}
/** 执行结束：进入 done（无论成败，逐条结果都在 results 里）。 */
function finishApply(state) {
    if (state.phase !== 'applying')
        return state;
    return { phase: 'done', plan: state.plan, results: state.results };
}
/** 给 UI 的分组：可同步 / 已最新 / 不可同步（跳过 + blocked + remote-newer）。 */
function syncGroups(plan) {
    const installable = plan.entries.filter((entry) => entry.action === 'install');
    const upToDate = plan.entries.filter((entry) => entry.action === 'up-to-date');
    const skipped = plan.entries.filter((entry) => entry.action !== 'install' && entry.action !== 'up-to-date');
    return { installable, upToDate, skipped };
}
/** 成功/失败计数（done 态标题用）。 */
function resultTotals(results) {
    let ok = 0;
    for (const result of results)
        if (result.ok)
            ok += 1;
    return { ok, failed: results.length - ok };
}
