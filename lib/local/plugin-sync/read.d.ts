import type { RemoteBundle } from '../../shared/plugin-sync.ts';
/**
 * 读远端已装的 bundle（RFC-0003 / T2）。
 *
 * 为什么是「自包含脚本 + 远端 node」而不是纯 shell：profile 的 `dsh.profile.bundles`
 * 是多行 JSON 数组，sed/tr 解析在转义上必然翻车；而 node 由引导器保证存在
 * （bootstrap 装 node 或远端本来就有）。实测见 spikes/m3-plugin-sync/README.md。
 *
 * 脚本用 **base64 投递**：`ssh host 'node -e "…"'` 会经过两层 shell，引号必被吃掉
 * （首跑就死在这）。写临时文件再执行，退出码与 stdout 都可判定。
 */
/** 与 `RemoteExec`（ssh/runtime.ts）结构兼容，方便 SSH / WSL 两侧注入。 */
export interface SyncExecResult {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}
export type SyncExec = (script: string, deadlineMs?: number) => Promise<SyncExecResult>;
export interface ReadBundlesRequest {
    readonly exec: SyncExec;
    /** 远端 node 的可执行描述：绝对路径，或 'node'（依赖 PATH）。 */
    readonly nodeCommand: string;
    /** DSH profile 名，默认 web。 */
    readonly profile?: string;
    /** 远端 home（用于定位 `<home>/.dsh/profiles`）；空则由脚本用 os.homedir()。 */
    readonly homeDir?: string;
    readonly deadlineMs?: number;
}
/** 把脚本文本 base64 化：躲开两层 shell 的引号与换行。 */
export declare function encodeScript(script: string): string;
/**
 * 生成一次远端读取的 shell 脚本。
 *
 * `set -e` 会让失败以非零退出码回来；临时文件一定删（`trap`），否则反复连接会在
 * 远端 /tmp 里堆垃圾。
 */
export declare function buildReadScript(request: {
    readonly nodeCommand: string;
    readonly profile: string;
    readonly homeDir: string;
}): string;
/**
 * 读一次远端 bundle 清单。
 *
 * 只在「脚本跑不动 / 输出不是 JSON / ok=false」时抛结构化错误；单个包读不到版本
 * 是**正常事实**（官方包在 profile 里就是 ENOENT），交给 diff 判定。
 */
export declare function readRemoteBundles(request: ReadBundlesRequest): Promise<readonly RemoteBundle[]>;
//# sourceMappingURL=read.d.ts.map