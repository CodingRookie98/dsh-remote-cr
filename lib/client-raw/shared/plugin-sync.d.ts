/**
 * 远端插件同步的**纯模型**：本地已装 vs 远端已装，差出该做什么。
 *
 * 为什么要单独一层：这是唯一「本地环境 → 远端环境」的判断，错了会直接改用户远端
 * （装错版本、装不该装的官方包）。所以它必须是纯函数、只产出 id 与版本，不碰 I/O，
 * 文案由客户端字典渲染（ADR-0007）。
 *
 * 规则顺序（RFC-0003 D6/D7）：
 *   官方 @deepseek-ai/* → 永不出现（随宿主自带，远端 profile 里本来就 ENOENT）
 *   本地版本未知        → blocked
 *   本地开发态路径插件  → skip-path（首版不打包上传）
 *   远端缺              → install（装本机确切版本）
 *   远端更旧            → install（升级到本机版本）
 *   远端更新            → remote-newer（不降级）
 *   一致                → up-to-date
 */
export type SyncAction = 'install' | 'up-to-date' | 'remote-newer' | 'skip-path' | 'blocked';
export type SyncReasonId = 'none' | 'missing-remote' | 'remote-older' | 'remote-newer' | 'local-path-plugin' | 'local-version-unknown';
/** 本地一个 bundle 的已装事实。`specKind` 缺省按 registry 处理。 */
export interface LocalBundle {
    readonly name: string;
    readonly version: string | null;
    readonly specKind?: 'registry' | 'path' | 'tarball' | 'git';
}
/** 远端一个 bundle 的已装事实（读不到版本时 version 为 null）。 */
export interface RemoteBundle {
    readonly name: string;
    readonly version: string | null;
}
export interface SyncEntry {
    readonly name: string;
    readonly action: SyncAction;
    readonly reasonId: SyncReasonId;
    readonly localVersion: string | null;
    readonly remoteVersion: string | null;
}
/** 单条安装结果（契约 §1）。 */
export interface SyncResult {
    readonly name: string;
    readonly ok: boolean;
    readonly code?: string;
    readonly detail?: string;
}
/** 官方包前缀：与远端 dsh 安装绑定，永不同步。 */
export declare const OFFICIAL_SCOPE = "@deepseek-ai/";
/**
 * 比较两个版本：负数 = a 更旧，0 = 相同，正数 = a 更新；解析不了时返回 null。
 *
 * 只覆盖同步需要的「同/新/旧」三态：不实现范围（`>=x <y`），那部分仍归宿主的
 * `engines` 判定。预发布按 semver 规则：有预发布 < 无预发布，预发布段逐段比较。
 */
export declare function comparePluginVersions(a: string, b: string): number | null;
/**
 * 差出「该做什么」。返回顺序固定：install → up-to-date → remote-newer → skip-path → blocked，
 * 组内按名字排，避免 UI 每次刷新顺序抖动。
 */
export declare function diffBundles(input: {
    readonly local: readonly LocalBundle[];
    readonly remote: readonly RemoteBundle[];
}): readonly SyncEntry[];
/** 给 UI 用的分组计数。 */
export declare function planTotals(entries: readonly SyncEntry[]): {
    readonly install: number;
    readonly upToDate: number;
    readonly skipped: number;
};
