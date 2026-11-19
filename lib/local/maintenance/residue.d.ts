import type { ResidueReportInfo, PurgeResultInfo } from '../../shared/api.ts';
/** 只读盘点需要的远端能力（`SyncBackend` 结构上满足它，测试里用假 exec）。 */
export interface ResidueBackend {
    readonly homeDir: string;
    /** SSH：本 target 的 staging 后缀（anchorId）；缺省时按目录内全部子目录报告。 */
    readonly stagingSuffix?: string;
    exec(script: string, deadlineMs?: number): Promise<{
        code: number;
        stdout: string;
        stderr: string;
    }>;
}
/** 盘点脚本：只读（`du`/`sed`/`kill -0`），不写任何东西。 */
export declare function buildResidueScript(homeDir: string, stagingSuffix: string | undefined): string;
/** 解析盘点输出。认不出的行跳过而不是编造（与 attach 的解析同一套纪律）。 */
export declare function parseResidue(stdout: string, targetId: string, checkedAt: string): ResidueReportInfo;
/** 清理脚本：删 staging 目录 + 只删「pid 已死」的实例登记。 */
export declare function buildPurgeScript(homeDir: string, stagingSuffix: string | undefined): string;
/** 解析清理输出：返回被删的路径与释放的 KB（心跳不算，只统计真实删除）。 */
export declare function parsePurge(stdout: string): PurgeResultInfo;
//# sourceMappingURL=residue.d.ts.map