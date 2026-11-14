/** 一条远端已有的工作区（只保留导入需要的字段）。 */
export interface RemoteWorkspaceRow {
    readonly workspaceId: string;
    readonly path: string;
    readonly title: string;
}
/** 解析 follow 流的首帧；不是 baseline 或形状不对都返回空（宁缺勿错）。 */
export declare function parseBaselineFrame(frame: unknown): readonly RemoteWorkspaceRow[];
/** 本地投影里已有的一条（只用来判重）。 */
export interface ExistingWorkspace {
    readonly workspaceId?: string | undefined;
    readonly remotePath?: string | null | undefined;
}
/**
 * 算出「可以导入」的候选：本地已有同 id 或同路径的一律跳过。
 *
 * 两条都要判：远端 id 是权威，但用户可能已经用**同一条路径**接入过一次
 * （那次 create 会返回同一个 id，所以正常情况下两者一致；判重是防御）。
 */
export declare function planImport(rows: readonly RemoteWorkspaceRow[], existing: readonly ExistingWorkspace[]): {
    readonly candidates: readonly RemoteWorkspaceRow[];
    readonly skipped: number;
};
//# sourceMappingURL=import.d.ts.map