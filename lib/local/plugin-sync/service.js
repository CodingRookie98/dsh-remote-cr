import { RemoteCrError } from "../backend/errors.js";
import { applySync } from "./apply.js";
import { readRemoteBundles } from "./read.js";
import { diffBundles, planTotals } from "../../shared/plugin-sync.js";
/** GET /plugin-sync 的内核：远端只读一次，不写任何东西。 */
export async function buildSyncPlan(request) {
    const profile = request.backend.profile ?? 'web';
    const remote = await readRemoteBundles({
        exec: request.backend.exec,
        nodeCommand: request.backend.nodeCommand,
        homeDir: request.backend.homeDir,
        profile,
        ...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }),
    });
    const entries = diffBundles({ local: request.local, remote });
    return {
        targetId: request.targetId,
        profile,
        entries,
        totals: planTotals(entries),
        muted: request.muted,
    };
}
/**
 * POST /plugin-sync 的内核：只接受 install 项；单条失败不影响其它条。
 *
 * 限流：同一 target 同时只允许一次执行 —— 并发执行会让 pnpm 在同一 profile 上互相踩。
 */
const applying = new Set();
export async function applySyncPlan(request) {
    if (applying.has(request.targetId)) {
        throw new RemoteCrError({
            code: 'remote/plugin-sync-unsupported',
            detail: '这台远端已经在同步中',
            nextActions: ['等当前同步结束', '或先关闭同步面板'],
        });
    }
    applying.add(request.targetId);
    try {
        return await applySync({
            entries: request.entries,
            exec: request.backend.exec,
            dshCommand: request.backend.dshCommand,
            nodeBin: request.backend.nodeBin,
            profile: request.backend.profile ?? 'web',
            ...(request.onResult === undefined ? {} : { onResult: request.onResult }),
            ...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }),
        });
    }
    finally {
        applying.delete(request.targetId);
    }
}
/** 测试用：清掉并发锁（进程内状态在用例之间必须复位）。 */
export function resetApplyingForTest() {
    applying.clear();
}
//# sourceMappingURL=service.js.map