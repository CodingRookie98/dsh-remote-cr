/**
 * WSL 远端路径 ↔ Windows UNC 路径。
 *
 * 为什么 UNC 是 M1 的主路径：真机实测（`spikes/m1/wsl-closed-loop`）对
 * `\\wsl.localhost\ubuntu_dev\home` 调 `fs.realpath()` 与 `stat().isDirectory()` 都通过，
 * 说明 **UNC 就是本机真实目录**，`createWorkspace({ path })` 可以直接吃。这正好绕开
 * DSH 硬限制「工作区必须是本机真实目录」。
 *
 * 两个候选前缀必须都留：
 * - `\\wsl.localhost\<distro>\...`：Win11 / 新版 WSL 的规范形式。
 * - `\\wsl$\<distro>\...`：老形式，某些环境（旧 WSL、部分 Samba/网络重定向场景）仍可用。
 * 按顺序试，第一个 `stat` 成功的即采用；两个都不行时报结构化错误，**不静默回落到本地**。
 */
/** UNC 前缀，按探测优先级排列。 */
export declare const UNC_PREFIXES: readonly ["\\\\wsl.localhost\\", "\\\\wsl$\\"];
/** 把 distro 内的 POSIX 绝对路径转成 UNC。反斜杠与路径分隔需按 Windows 侧写法归一。 */
export declare function toUnc(distro: string, posixPath: string, prefixIndex?: number): string;
/** 所有候选 UNC，按优先级排列；调用方依次 `stat`，第一个成功者即答案。 */
export declare function uncCandidates(distro: string, posixPath: string): string[];
/** UNC 反向解析回 distro 内路径（用于「用户选了 UNC 路径」时还原给远端）。 */
export declare function fromUnc(unc: string): {
    distro: string;
    posixPath: string;
} | undefined;
/**
 * 远端文件读取的降级路线：UNC 直接读 → `cat >` 通过 `--exec` 回退。
 *
 * 为什么需要回退：UNC 读走的是 Windows 侧的重定向，某些场景（权限、符号链接、
 * `/proc` 之类非普通文件）会失败；这时用 `--exec cat` 把内容搬到本地是可靠兜底。
 * 注意这是**读**的兜底；写仍走 UNC（`cat >` 回退写入会改 UID/GID，M1 不做）。
 */
export declare const UNC_FALLBACK_REASON: readonly ["UNC 读失败（权限 / 符号链接 / 非普通文件）", "改用 --exec cat 把内容搬到本地"];
//# sourceMappingURL=unc.d.ts.map