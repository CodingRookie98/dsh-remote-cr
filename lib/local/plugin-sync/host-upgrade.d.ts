import type { SyncExec } from './read.ts';
/**
 * 把远端宿主升到本地这一个版本（H 系列 / 只做 registry 路径）。
 *
 * 两步、两次 exec，各自对应一种**不同**的失败：
 * 1. registry 探测：`npm view <pkg>@<version> version` —— 非零 = 这个版本不在 registry 上
 *    （本地是 dev 构建、或版本没发布）→ `remote/host-version-unavailable`。
 * 2. 安装：复用引导器的 `buildDshPackageScript`（同一份真相，不另写一套 npm 调用），
 *    装完必须自报版本；不符 → `remote/host-upgrade-failed`。
 *
 * 不在这里重启远端：重启 = 断连，属用户动作（面板已有「重新连接」，真机 13.7–16.8 s）。
 */
export declare const REGISTRY_UNAVAILABLE_MARK = "REMOTE_CR_VERSION_UNAVAILABLE";
export declare const HOST_INSTALLED_MARK = "REMOTE_CR_DSH_OK";
export interface HostUpgradeRequest {
    readonly exec: SyncExec;
    /** 远端 dsh 的来源根：staging 形态下是 `<home>/.dsh-remote-cr/staging/<id>`。 */
    readonly stagingDir: string;
    /** 远端 node 的 bin 目录；空或哨兵 `$PATH` 表示「用系统 npm」。 */
    readonly nodeBin: string;
    readonly version: string;
    readonly dshHome: string;
    readonly registry: string;
    readonly deadlineMs?: number;
}
/** 哨兵 `$PATH` 是读取脚本用来表示「没装私有 node」的，不是一个路径。 */
export declare function npmCommandFor(nodeBin: string): string;
/** 探测脚本：版本不存在时以 6 退出并打标记，让上层把「未发布」和「网络坏了」分开说。 */
export declare function buildRegistryProbeScript(request: {
    readonly version: string;
    readonly nodeBin: string;
    readonly registry: string;
}): string;
/** 安装脚本：引导器那份 + 装完自报版本（上层据此判定「真的换成了」）。 */
export declare function buildHostInstallScript(request: Omit<HostUpgradeRequest, 'exec'>): string;
/**
 * 从安装输出里取「装完自报的版本」；没有标记就当作没验过。
 *
 * 不是只看标记前一行（R2-S5）：`dsh --version` 在异常情况下可能多打一行（例如 `build abc`），
 * 那样会把一次成功的安装判成「自报版本不符」，用户只能反复重试同一个假失败。
 * 从标记往上扫最近一条**像 semver 的行**，扫不到才算没验过。
 */
export declare function parseInstalledVersion(stdout: string): string | null;
export declare function upgradeRemoteHost(request: HostUpgradeRequest): Promise<{
    readonly version: string;
}>;
//# sourceMappingURL=host-upgrade.d.ts.map