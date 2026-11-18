const holders = new Map();
export function acquireWrite(targetId, kind) {
    const holder = holders.get(targetId);
    if (holder !== undefined)
        return { ok: false, holder };
    holders.set(targetId, kind);
    return { ok: true };
}
export function releaseWrite(targetId) {
    holders.delete(targetId);
}
/** 当前持有者（测试与 UI 用）；没人持有返回 null。 */
export function writeHolder(targetId) {
    return holders.get(targetId) ?? null;
}
/** 测试用：进程内状态在用例之间必须复位。 */
export function resetWritesForTest() {
    holders.clear();
}
//# sourceMappingURL=locks.js.map