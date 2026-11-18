/**
 * 原因 id → 字典键的**类型化映射**（ADR-0007）。
 * 用 `as never` 拼键会让 tsc 失去保护，漏一个键只会在屏上印出 key。
 */
export const SYNC_REASON_KEYS = {
    none: 'syncReason.missing-remote',
    'missing-remote': 'syncReason.missing-remote',
    'remote-older': 'syncReason.remote-older',
    'remote-newer': 'syncReason.remote-newer',
    'local-path-plugin': 'syncReason.local-path-plugin',
    'local-version-unknown': 'syncReason.local-version-unknown',
};
/** 宿主版本拒绝原因 → 字典键（同一手法：类型化，漏键 tsc 就报）。 */
export const HOST_REASON_KEYS = {
    none: 'sync.host.upToDate',
    'checkout-mode': 'syncHostReason.checkout-mode',
    'source-unknown': 'syncHostReason.source-unknown',
    'local-version-unknown': 'syncHostReason.local-version-unknown',
    'out-of-range': 'syncHostReason.out-of-range',
    'remote-version-unknown': 'syncHostReason.remote-version-unknown',
};
export const CLOSED = { phase: 'closed' };
/** 打开对话框：进入 loading（数据随后由 receiveSyncPlan 填）。 */
export function openSync() {
    return { phase: 'loading' };
}
export function closeSync() {
    return CLOSED;
}
export function failSync(failure) {
    return { phase: 'failed', failure };
}
/** 计划到达：默认全选「可同步」项（up-to-date / skip / blocked 不可选）。 */
export function receiveSyncPlan(plan) {
    const selected = plan.entries.filter((entry) => entry.action === 'install').map((entry) => entry.name);
    return { phase: 'ready', plan, selected };
}
export function toggleSyncEntry(state, name) {
    if (state.phase !== 'ready')
        return state;
    const has = state.selected.includes(name);
    const selected = has ? state.selected.filter((item) => item !== name) : [...state.selected, name];
    return { ...state, selected };
}
export function selectAllSync(state, select) {
    if (state.phase !== 'ready')
        return state;
    const installable = state.plan.entries.filter((entry) => entry.action === 'install').map((entry) => entry.name);
    return { ...state, selected: select ? installable : [] };
}
/** 开始执行：必须有选中项，否则原地不动（按钮层也会禁用，双保险）。 */
export function beginApply(state) {
    if (state.phase !== 'ready' || state.selected.length === 0)
        return state;
    return { phase: 'applying', plan: state.plan, selected: state.selected, results: [] };
}
export function receiveResult(state, result) {
    if (state.phase !== 'applying')
        return state;
    return { ...state, results: [...state.results, result] };
}
/** 执行结束：进入 done（无论成败，逐条结果都在 results 里）。 */
export function finishApply(state) {
    if (state.phase !== 'applying')
        return state;
    return { phase: 'done', plan: state.plan, results: state.results };
}
/**
 * 把「一次接入的目标」翻成同步用的 target（审查 N1）。
 *
 * 为什么必须从**接入入参**取而不是读 snapshot：`openSyncDialog` 在 attach 之后立刻调用，
 * 此刻 `setSnapshot` 还没应用到本次渲染闭包 —— 读 snapshot 会拿到 null（首次接入）或
 * **上一台主机**（切换目标）。这里做成纯函数，接入路径与面板路径共用。
 */
export function syncTargetOf(target) {
    if (target.backend === 'ssh') {
        const alias = target.alias ?? '';
        return alias === '' ? null : { backend: 'ssh', alias, port: target.port, remoteRoot: target.remoteRoot };
    }
    if (target.backend === 'wsl') {
        const distro = target.distro ?? '';
        return distro === '' ? null : { backend: 'wsl', distro, port: target.port, remoteRoot: target.remoteRoot };
    }
    return null;
}
/** 远端没装 dsh 时不能同步：命令会指向一个不存在的入口（审查 B1）。 */
export function syncBlockedReason(plan) {
    // 条件必须与 `applySyncPlan` 的后端门禁同形（runtime 为空 **且** 该后端必须有 runtime），
    // 否则 SSH（dsh 在 PATH 上时 runtime 也是 null）会被 UI 误拦。字段缺省 = 老宿主 = 不拦。
    return plan.runtime === null && plan.requiresRuntime === true ? 'no-runtime' : null;
}
/**
 * 失败面的「可照抄」两件东西：命令与远端原文。
 *
 * 为什么单独抽出来：`localizeFailure` 会把 nextActions 换成本地化字典文案（`errNext.*`），
 * 精确命令（含 staging 路径）与 npm 原文只能靠这两个字段原样呈现（2026-11-18 R1 BLK-4）。
 * 空串一律折成 null：渲染层据此决定要不要画那块，而不是画一个空白框。
 */
export function hostFailureExtras(failure) {
    const clean = (value) => {
        if (value === null || value === undefined)
            return null;
        const trimmed = value.trim();
        return trimmed === '' ? null : trimmed;
    };
    return { command: clean(failure.command), logTail: clean(failure.logTail) };
}
/** 宿主版本这一行怎么画：null = 旧宿主没这个字段，不渲染（不拿不存在的门禁去拦老版本）。 */
export function hostPanelOf(plan) {
    return plan.host ?? null;
}
/** 给 UI 的分组：可同步 / 已最新 / 不可同步（跳过 + blocked + remote-newer）。 */
export function syncGroups(plan) {
    const installable = plan.entries.filter((entry) => entry.action === 'install');
    const upToDate = plan.entries.filter((entry) => entry.action === 'up-to-date');
    const skipped = plan.entries.filter((entry) => entry.action !== 'install' && entry.action !== 'up-to-date');
    return { installable, upToDate, skipped };
}
/**
 * 可复制的同步报告（done 态「复制日志」）。
 *
 * 只放**事实与码**：包名、动作、版本、结果、code/detail；不放远端路径（可能含用户名）。
 */
export function syncReport(state) {
    if (state.phase !== 'done' && state.phase !== 'applying')
        return '';
    const lines = [
        'dsh-remote-cr plugin sync',
        'profile: ' + state.plan.profile,
        'target: ' + state.plan.targetId,
        'results: ' + String(state.results.length),
    ];
    for (const result of state.results) {
        lines.push((result.ok ? 'ok   ' : 'FAIL ') +
            result.name +
            (result.ok ? '' : ' ' + (result.code ?? '') + (result.detail === undefined ? '' : ' — ' + result.detail)));
    }
    return lines.join('\n');
}
/** 成功/失败计数（done 态标题用）。 */
export function resultTotals(results) {
    let ok = 0;
    for (const result of results)
        if (result.ok)
            ok += 1;
    return { ok, failed: results.length - ok };
}
//# sourceMappingURL=sync-state.js.map