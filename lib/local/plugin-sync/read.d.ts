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
/**
 * 远端 dsh 检出里的 CLI 入口（相对检出根）。与 `ssh/runtime.ts`、`wsl/launch.ts` 是同一个约定：
 * 检出里跑 `node apps/cli/lib/bin.js`，而不是假设 `dsh` 在 PATH 上。
 */
export declare const DSH_CLI_RELATIVE = "apps/cli/lib/bin.js";
export interface ReadBundlesRequest {
    readonly exec: SyncExec;
    /** 远端 node 的可执行描述：绝对路径，或 'node'（依赖 PATH）。 */
    readonly nodeCommand: string;
    /** DSH profile 名，默认 web。 */
    readonly profile?: string;
    /** 远端 home（用于定位 `<home>/.dsh/profiles`）；空则由脚本用 os.homedir()。 */
    readonly homeDir?: string;
    /**
     * 远端 dsh 检出根（WSL 的 `remoteRoot`、SSH 的 `remoteRoot`）。给了才在**同一次**往返里
     * 顺带探明检出形态的运行时（`dshCommand` + `interpreter`）；没给就只认 staging。
     */
    readonly checkoutRoot?: string;
    readonly deadlineMs?: number;
}
/**
 * 远端脚本正文。**导出给单测**：它是拼出来的 JS 源码，少一个括号只会在真机上变成
 * `SyntaxError: Unexpected token`（一次真机 debug 换来的教训），必须在单测里就红。
 */
export declare const READER_SOURCE: string;
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
    readonly checkoutRoot?: string;
    readonly stagingSuffix?: string;
}): string;
/** 远端「用哪个 node / 哪个 dsh」——同一次读取里探明，省掉第二次 exec。 */
export interface RemoteRuntimePaths {
    readonly homeDir: string;
    readonly nodeCommand: string;
    readonly nodeBin: string;
    readonly dshCommand: string;
    /**
     * 跑 `dshCommand` 的解释器：检出形态是 `node <bin.js>`（不假设 bin.js 有 +x），
     * staging 形态的 `dsh` 本身可执行 → null。
     */
    readonly interpreter: string | null;
    /** dsh 的来源根：SSH 的 staging 目录，或（检出形态，WSL 常见）检出根目录。`dshCommand` 就在它里面。 */
    readonly dshRoot: string;
    /** 来源形态：`staging` 可由 registry 升级；`checkout` 只能换检出（拒绝自动升级）。 */
    readonly source: 'staging' | 'checkout';
}
/**
 * 读一次远端 bundle 清单。
 *
 * 只在「脚本跑不动 / 输出不是 JSON / ok=false」时抛结构化错误；单个包读不到版本
 * 是**正常事实**（官方包在 profile 里就是 ENOENT），交给 diff 判定。
 */
export interface RemoteProfileRead {
    readonly bundles: readonly RemoteBundle[];
    /** 远端既没有 staging 也没有检出时为 null（此时同步应当提示「先接入一次」）。 */
    readonly runtime: RemoteRuntimePaths | null;
    /** 远端 dsh 自报的版本（同一次 exec 里问的）；读不到为 null。 */
    readonly dshVersion: string | null;
}
export declare function readRemoteProfile(request: ReadBundlesRequest): Promise<RemoteProfileRead>;
/** 兼容入口：只要清单。 */
export declare function readRemoteBundles(request: ReadBundlesRequest): Promise<readonly RemoteBundle[]>;
//# sourceMappingURL=read.d.ts.map