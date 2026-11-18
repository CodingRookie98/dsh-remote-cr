/**
 * 「不再提醒」的本地落盘（RFC-0003 D5）。
 *
 * 存**本地**状态根而不是远端：这是用户对「这台机器别再弹了」的偏好，与远端环境无关；
 * 存远端还会反过来要求远端可写。粒度是 targetId（host+user+port 的 hash，与 anchors 同源）。
 *
 * 读失败一律当空：偏好文件损坏不该让同步功能整体不可用。
 */
export interface OptoutFile {
    readonly version: 1;
    readonly targets: readonly string[];
}
export declare function readOptout(file: string): readonly string[];
export declare function writeOptout(file: string, targets: readonly string[]): void;
/** 增删一个 target 的静音状态，返回最新列表。 */
export declare function setMuted(file: string, targetId: string, muted: boolean): readonly string[];
/** 文件是否存在（供诊断/doctor 用）。 */
export declare function optoutExists(file: string): boolean;
//# sourceMappingURL=optout.d.ts.map