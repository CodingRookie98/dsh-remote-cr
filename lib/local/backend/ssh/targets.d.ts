/**
 * SSH 来源的**发现层**：把用户 `~/.ssh/config` 里的主机变成面板能列的一行行来源。
 *
 * 与 `config.ts` 的分工：那里是纯解析（文本 → 块 / 目标 / 问题）；这里只负责
 * 「去哪儿读、读不到怎么办、给浏览器看什么」。
 *
 * **给浏览器的形状刻意不含 host / user / 私钥路径**：`/sources` 的响应会直接进页面，
 * 凭据侧的信息（用户名、内网地址、密钥路径）没有一条需要出现在 DOM 里。面板按 alias
 * 选目标就够了——那也是用户在 config 里自己写的名字。
 */
import type { SshSourceReport } from '../../../shared/api.ts';
import { type SshTarget } from './config.ts';
export interface SshSourcesOptions {
    /** **本地** home（`~/.ssh/config` 的位置）。 */
    readonly homeDir: string;
    /** 显式指定配置文件；省略时用 `<homeDir>/.ssh/config`。 */
    readonly file?: string;
    readonly readFile?: (path: string) => string;
    readonly exists?: (path: string) => boolean;
}
export declare function defaultSshConfigFile(homeDir: string): string;
/**
 * 列出可连的 SSH 目标。
 *
 * **读不到 config 不是错误**：大多数用户根本没写过 `~/.ssh/config`，这时候应该显示
 * 「没有可用的 SSH 主机」并把 config 路径指出来（用户据此知道该写哪个文件），而不是抛异常。
 */
export declare function listSshSources(options: SshSourcesOptions): SshSourceReport;
/**
 * 按别名解析出一个完整目标；找不到时给**人话原因**（面板要显示它）。
 *
 * 与 `listSshSources` 分开：列表要的是「有哪些」，接入要的是「这一个的 host/user/密钥」。
 * 后者只在真正要连的时候才需要，不该让一次列表把每个别名都解析一遍密钥路径。
 */
export declare function resolveTargetByAlias(options: SshSourcesOptions & {
    readonly alias: string;
}): {
    readonly target: SshTarget | undefined;
    readonly reason: string | null;
};
/** 默认读盘实现：给生产装配用（测试走注入）。 */
export declare function nodeSshSourcesOptions(): Required<Pick<SshSourcesOptions, 'readFile' | 'exists'>>;
//# sourceMappingURL=targets.d.ts.map