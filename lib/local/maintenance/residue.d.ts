/**
 * 远端残留的只读盘点与显式清理（RFC-0006 Phase 2，**v2**）。
 *
 * v1 的三处错（P4 红队 N0/N1/N2 实测）：
 * 1. 拿 `SyncBackend.homeDir` 拼绝对路径——生产 wiring 传的是**空串**，于是 SSH 拼出永不存在的嵌套路径（空转），
 *    WSL 拼出**相对路径**（`wsl.exe --exec` 继承宿主 cwd）→ `rm -rf` 会删到工作目录下同名树；
 * 2. 在 shell 里用 `cut -d, -f2` 猜 pid——字段顺序一变就取到别的数字，**活着的登记会被删**；
 * 3. 路径没有白名单，`..` 或空串能越界。
 *
 * v2 的三条硬约束：
 * - 所有路径都由远端自己的 `$HOME` 拼（**不接受任何外部路径**），只接受一个校验过的 anchor id；
 * - 解析与判活全在 TS：脚本只负责 `cat` 与 `[ -d /proc/$p ]`，不再在 shell 里猜 JSON；
 * - 删除必须逐条看 `rm` 的退出码，失败要能上报（v1 会无条件 echo「已删除」）。
 */
import type { PurgeResultInfo, ResidueInstanceFileInfo, ResidueReportInfo } from '../../shared/api.ts';
/** 盘点/清理需要的远端能力（`SyncBackend` 结构上满足它）。 */
export interface ResidueExec {
    exec(script: string, deadlineMs?: number): Promise<{
        code: number;
        stdout: string;
        stderr: string;
    }>;
}
/**
 * 从 sync 的 `stagingSuffix`（形如 `.dsh-remote-cr/staging/<anchorId>`）取出 anchor id。
 *
 * 只接受这一种形态：取不到就抛（宁可报错也不猜一个路径去删）。`undefined` 表示「整个 staging」（WSL：
 * 该 distro 下所有 target 共用同一个 staging 目录）。
 */
export declare function stagingIdOf(stagingSuffix: string | undefined): string | null;
/** 盘点脚本：只读。实例文件原样 `cat` 出来，交给 TS 解析（不在 shell 里猜字段）。 */
export declare function buildResidueScript(id: string | null | undefined): string;
/** 判活脚本：pid 由 TS 校验成正整数后才拼进来。`/proc` 优先（权限无关），再退回 kill -0。 */
export declare function buildLivenessScript(pids: readonly number[]): string;
/** 解析盘点输出。JSON 解析失败或 pid 不可信时 `pid=null`（purge 据此**不删**）。 */
export declare function parseResidue(stdout: string, targetId: string, checkedAt: string): ResidueReportInfo;
/** 把 liveness 结果合并进盘点（只认 `ALIVE=<pid>` 行）。 */
export declare function applyLiveness(report: ResidueReportInfo, stdout: string): ResidueReportInfo;
/** 清理计划：由 TS 决定删什么（不把判断留给 shell）。 */
export interface PurgePlan {
    readonly removeStaging: boolean;
    /** staging 为什么没被删（null = 没跳过）。 */
    readonly skipReason: 'resident-alive' | null;
    readonly instances: readonly ResidueInstanceFileInfo[];
}
export declare function planPurge(report: ResidueReportInfo): PurgePlan;
/** 清理脚本：逐条看 `rm` 的退出码，失败要能上报（v1 会无条件 echo「已删除」）。 */
export declare function buildPurgeScript(id: string | null | undefined, plan: PurgePlan): string;
/** 解析清理输出：`failures` 非空表示「报了成功的地方其实没删掉」。 */
export declare function parsePurge(stdout: string): PurgeResultInfo & {
    readonly failures: readonly string[];
};
//# sourceMappingURL=residue.d.ts.map