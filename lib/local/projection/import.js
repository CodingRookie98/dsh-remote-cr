/**
 * 「导入远端已有工作区」的纯逻辑（M4-1）。
 *
 * 为什么需要它：DSH 的 workspace 一元方法里**没有 list**，唯一的读入口是
 * `workspace/follow` 流，且每代都以一帧 `{ type: 'baseline', value: { items } }` 开场。
 * 所以导入 = 开流 → 读首帧 → 关流，再把 items 里用户勾中的路径逐个 `workspace/create`
 * 投影进来（create 幂等，远端已有就复用）。
 *
 * 这一层不做 IO：帧的解析与去重必须能在 node 里断言，否则「导入把重复工作区灌进侧栏」
 * 这种错误只能靠肉眼发现。
 */
// 本地两个守卫：`attach.ts` 的那两个是**未导出**的内部实现，跨模块复用会把它的
// 内部形状变成契约。导入只关心「是不是对象 / 是不是非空字符串」，各留一份更清楚。
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function asString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
/** 解析 follow 流的首帧；不是 baseline 或形状不对都返回空（宁缺勿错）。 */
export function parseBaselineFrame(frame) {
    let record = asRecord(frame);
    if (record === undefined)
        return [];
    // 真机实测：流会给每一帧再包一层 `{ type: 'item', value: <frame> }`。
    // 不脱这层壳的话恒返回空，表现为「远端明明有工作区，导入列表却是空的」。
    if (asString(record['type']) === 'item') {
        const inner = asRecord(record['value']);
        if (inner === undefined)
            return [];
        record = inner;
    }
    if (asString(record['type']) !== 'baseline')
        return [];
    const value = asRecord(record['value']);
    if (value === undefined)
        return [];
    const items = value['items'];
    if (!Array.isArray(items))
        return [];
    const rows = [];
    for (const item of items) {
        const view = asRecord(item);
        if (view === undefined)
            continue;
        const workspaceId = asString(view['workspaceId']);
        const path = asString(view['path']);
        if (workspaceId === undefined || path === undefined)
            continue;
        rows.push({ workspaceId, path, title: asString(view['title']) ?? path });
    }
    return rows;
}
/**
 * 算出「可以导入」的候选：本地已有同 id 或同路径的一律跳过。
 *
 * 两条都要判：远端 id 是权威，但用户可能已经用**同一条路径**接入过一次
 * （那次 create 会返回同一个 id，所以正常情况下两者一致；判重是防御）。
 */
export function planImport(rows, existing) {
    const ids = new Set();
    const paths = new Set();
    for (const item of existing) {
        if (item.workspaceId !== undefined)
            ids.add(item.workspaceId);
        if (item.remotePath !== null && item.remotePath !== undefined)
            paths.add(item.remotePath);
    }
    const candidates = [];
    let skipped = 0;
    for (const row of rows) {
        if (ids.has(row.workspaceId) || paths.has(row.path)) {
            skipped += 1;
            continue;
        }
        // 远端本身可能有两条同路径记录（不同 id）：只导一条，避免侧栏出现两个一样的卡片。
        if (paths.has(row.path)) {
            skipped += 1;
            continue;
        }
        paths.add(row.path);
        candidates.push(row);
    }
    return { candidates, skipped };
}
//# sourceMappingURL=import.js.map