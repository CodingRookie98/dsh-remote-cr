import { RemoteCrError } from "../backend/errors.js";
import { applySync } from "./apply.js";
import { acquireWrite, releaseWrite, resetWritesForTest } from "./locks.js";
import { readRemoteProfile } from "./read.js";
import { decideHostSync, diffBundles, planTotals } from "../../shared/plugin-sync.js";
/** GET /plugin-sync 的内核：远端只读一次，不写任何东西。 */
export async function buildSyncPlan(request) {
    const profile = request.backend.profile ?? 'web';
    const remote = await readRemoteProfile({
        exec: request.backend.exec,
        nodeCommand: request.backend.nodeCommand,
        homeDir: request.backend.homeDir,
        ...(request.backend.checkoutRoot === undefined ? {} : { checkoutRoot: request.backend.checkoutRoot }),
        ...(request.backend.stagingSuffix === undefined ? {} : { stagingSuffix: request.backend.stagingSuffix }),
        profile,
        ...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }),
    });
    const supported = request.backend.supported ?? (() => true);
    const entries = diffBundles({ local: request.local, remote: remote.bundles });
    return {
        targetId: request.targetId,
        profile,
        entries,
        totals: planTotals(entries),
        muted: request.muted,
        runtime: remote.runtime,
        requiresRuntime: request.backend.requiresRuntime === true,
        host: decideHostSync({
            localVersion: request.backend.hostVersion ?? null,
            remoteVersion: remote.dshVersion,
            source: remote.runtime?.source ?? null,
            supported,
        }),
    };
}
/**
 * POST /plugin-sync 的内核：只接受 install 项；单条失败不影响其它条。
 *
 * 限流：与宿主升级共用一把锁（`locks.ts`）——两者写的是同一份 `<staging>/npm`，
 * 各管各的会让「升级中点同步」互相踩（R1-B1）。
 */
export async function applySyncPlan(request) {
    const lock = acquireWrite(request.targetId, 'apply');
    if (!lock.ok) {
        throw new RemoteCrError({
            code: 'remote/plugin-sync-busy',
            detail: lock.holder === 'host' ? '这台远端正在升级宿主，等它结束再同步' : '这台远端已经在同步中',
            nextActions: ['等当前动作结束', '或先关闭同步面板'],
        });
    }
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
        releaseWrite(request.targetId);
    }
}
/** 测试用：清掉并发锁（进程内状态在用例之间必须复位）。 */
export function resetApplyingForTest() {
    resetWritesForTest();
}
//# sourceMappingURL=service.js.map