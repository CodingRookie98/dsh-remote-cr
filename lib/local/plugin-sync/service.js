import { RemoteCrError } from "../backend/errors.js";
import { applySync } from "./apply.js";
import { readRemoteProfile } from "./read.js";
import { diffBundles, planTotals } from "../../shared/plugin-sync.js";
/** GET /plugin-sync 的内核：远端只读一次，不写任何东西。 */
export async function buildSyncPlan(request) {
    const profile = request.backend.profile ?? 'web';
    const remote = await readRemoteProfile({
        exec: request.backend.exec,
        nodeCommand: request.backend.nodeCommand,
        homeDir: request.backend.homeDir,
        ...(request.backend.checkoutRoot === undefined ? {} : { checkoutRoot: request.backend.checkoutRoot }),
        profile,
        ...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }),
    });
    const entries = diffBundles({ local: request.local, remote: remote.bundles });
    return {
        targetId: request.targetId,
        profile,
        entries,
        totals: planTotals(entries),
        muted: request.muted,
        runtime: remote.runtime,
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
        const runtime = request.runtime ?? null;
        // 没有 runtime 时兜底命令按定义指向不存在的入口（检出不存在才判 null）——不能把它当出路。
        if (runtime === null && request.backend.requiresRuntime === true) {
            throw new RemoteCrError({
                code: 'remote/plugin-sync-read-failed',
                detail: '远端没有可用的 dsh：既没有 staging 安装，也没有检出（' + request.backend.dshCommand + '）',
                nextActions: ['先在面板里接入这台远端（会启动远端 dsh），再回来同步', '或确认远端目录里有一份 dsh 检出（含 apps/cli/lib/bin.js）'],
            });
        }
        return await applySync({
            entries: request.entries,
            exec: request.backend.exec,
            dshCommand: runtime?.dshCommand ?? request.backend.dshCommand,
            nodeBin: runtime?.nodeBin ?? request.backend.nodeBin,
            interpreter: runtime?.interpreter ?? request.backend.interpreter ?? null,
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