/**
 * SSH 客户端配置的解析与解析后校验。
 *
 * 这一层**只碰文本，不碰网络也不碰文件**（`Include` 的展开在 `readSshConfig`，
 * 读盘由调用方注入），所以能在任何机器上跑单测——和 `wsl/distro.ts` 的分工一样。
 *
 * 三条来自真实配置（本机 `C:/Users/hui/.ssh/config`，2026-11-12 通读）的事实，
 * 决定了实现不能想当然：
 * 1. **一个 `Host` 可以带多个别名**（`Host gcp gcp-vps self-hosted hindsight-server`），
 *    它们共享同一块选项；把 `Host` 后面的第一个词当名字会丢掉其余三个。
 * 2. **`IdentityFile` 会写成 Windows 形态**（`~\\.ssh\\id_ed25519`）；直接当 POSIX 路径
 *    用会得到 `C:\\Users\\hui\\.ssh/id_ed25519` 这种半截路径。
 * 3. **`IdentityFile` 常被误配成公钥**（本机 11 个 Host 里有 4 个写的是 `.pub`）；
 *    OpenSSH 拿公钥签不了名，只会回一句 `Permission denied`，用户完全看不出原因。
 *    这里必须**在连接前**报错并指到具体那一行。
 *
 * 语义按 OpenSSH 的「先到先得」：`HostName`/`User`/`Port` 取**第一个**匹配块的第一个值；
 * 唯独 `IdentityFile` 是**累加**的（`ssh_config(5)`：IdentityFile may be used multiple
 * times），`IdentityFile none` 则清空之前累加的那批。
 */
export interface SshConfigProblem {
    readonly code: 'host-without-pattern' | 'port-invalid' | 'identity-is-public-key' | 'tildeg-user-unsupported' | 'include-unreadable' | 'include-too-deep' | 'proxy-jump-empty';
    /** 中文可操作文案：用户看完就知道改哪一行、改成什么。 */
    readonly message: string;
    readonly file: string;
    readonly line: number;
}
/** 一条 `IdentityFile` 及其**自己那一行**：报错必须指到可以改的那一行，而不是 Host 行。 */
export interface SshIdentityFile {
    readonly raw: string;
    readonly line: number;
}
export interface SshHostBlock {
    /** `Host` 后面的全部模式（可能是通配）。全局选项块为 `['*']`。 */
    readonly patterns: readonly string[];
    readonly hostName: string | undefined;
    readonly user: string | undefined;
    readonly port: number | undefined;
    /** 按出现顺序累加；`IdentityFile none` 会清空此前的结果。 */
    readonly identityFiles: readonly SshIdentityFile[];
    readonly proxyJump: readonly string[];
    /** 1-based，指向 `Host` 那一行。 */
    readonly line: number;
    /** 出现在第一个 `Host` 之前：OpenSSH 语义是「对所有主机生效」。 */
    readonly implicit: boolean;
    /** 本块里出现了但本层不解释的键（如 `ServerAliveInterval`），仅用于诊断。 */
    readonly ignoredKeys: readonly string[];
}
/** `Host` 块与 `Include` 指令的**原始出现顺序**。 */
export type SshConfigEntry = {
    readonly kind: 'block';
    readonly block: SshHostBlock;
} | {
    readonly kind: 'include';
    readonly pattern: string;
    readonly line: number;
};
export interface ParsedSshConfig {
    readonly blocks: readonly SshHostBlock[];
    readonly problems: readonly SshConfigProblem[];
    /** 未展开的 `Include` 指令，交给 `readSshConfig` 处理。 */
    readonly includes: readonly {
        readonly pattern: string;
        readonly line: number;
    }[];
    /**
     * 顺序敏感的条目流：`Include` 必须**在它出现的位置**展开，否则「先到先得」的优先级会错。
     * 例：主文件先 `Include extra`（里面写 `Host dup User a`），后面又写 `Host dup User b`，
     * 正确结果 User=a；若把 Include 的内容追加到末尾就会得到 b。
     */
    readonly entries: readonly SshConfigEntry[];
}
/**
 * 解析配置文件正文。
 *
 * **不剥行内注释**：OpenSSH 只把**行首**的 `#` 当注释，`Host foo # bar` 里的 `# bar`
 * 是模式的一部分。按「行内注释」去截断会让模式悄悄变成 `foo`，与本机 OpenSSH 的行为不一致。
 */
export declare function parseSshConfig(text: string, file?: string): ParsedSshConfig;
/**
 * 单个 `Host` 模式与别名的匹配：支持 `*` 与 `?`，其余字符**逐字面**比较。
 *
 * 不做大小写折叠：OpenSSH 的别名匹配是大小写敏感的（`Host Foo` 不匹配 `foo`）。
 */
export declare function matchHostPattern(pattern: string, alias: string): boolean;
export interface SshHop {
    readonly host: string;
    readonly user: string | undefined;
    readonly port: number;
}
export interface SshTarget {
    readonly alias: string;
    readonly hostName: string;
    readonly user: string | undefined;
    /** 未写 User 时为 undefined，由调用方按 `$USER`/`whoami` 兜底，不在这里猜。 */
    readonly port: number;
    /** 已展开并规范化（`~` → home，`\\` → `/`）的私钥路径。 */
    readonly identityFiles: readonly string[];
    readonly proxyJump: readonly SshHop[];
    readonly source: {
        readonly file: string;
        readonly line: number;
    };
}
export interface ResolveOptions {
    /** 本地 home，用于展开 `~`。 */
    readonly homeDir: string;
    readonly file?: string;
}
/**
 * 把`~`展开成 home 目录、把 `\\` 统一成 `/`。
 *
 * `~otheruser` 不展开：它不是「当前用户的 home」，硬展开只会得到一个不存在的路径，
 * 所以如实报问题，让用户改成绝对路径。
 */
export declare function expandSshPath(raw: string, options: {
    readonly homeDir: string;
}): {
    readonly path: string;
} | {
    readonly problem: 'tildeg-user-unsupported' | 'empty';
};
/**
 * 解析出**一个**可连接目标。
 *
 * 先按 OpenSSH 语义合并所有匹配块（`*` 全局块也参与），再校验私钥。校验放在这里而不是
 * 解析里，是因为「是不是公钥」需要知道最终路径；但判断只看扩展名，不读盘——
 * 文件不存在与扩展名错误是两件事，后者必须在连接前就点明。
 */
export declare function resolveSshTarget(parsed: ParsedSshConfig, alias: string, options: ResolveOptions): {
    readonly target: SshTarget | undefined;
    readonly problems: readonly SshConfigProblem[];
};
/**
 * 列出所有**具体**目标（面板要展示的那些）。
 *
 * 通配模式（`Host *`、`Host *.internal`）不是目标，它们是规则；`Include` 已由读取层展开。
 * 别名按**区分大小写**去重（OpenSSH 的别名就是区分大小写的），重复定义取第一块。
 */
export declare function listSshTargets(parsed: ParsedSshConfig, options: ResolveOptions): {
    readonly targets: readonly SshTarget[];
    readonly problems: readonly SshConfigProblem[];
};
export interface ReadSshConfigOptions {
    readonly file: string;
    readonly homeDir: string;
    /** 注入读盘，便于单测；默认 `node:fs`。 */
    readonly readFile?: (path: string) => string;
    readonly exists?: (path: string) => boolean;
    /** `Include` 递归上限：配置成环时必须停，不能把进程拖死。 */
    readonly maxDepth?: number;
}
/**
 * 读配置并在**原位置**展开 `Include`（`ssh_config(5)`：相对路径按 `~/.ssh` 解析，
 * `*` 通配按字典序，深度上限防成环）。
 *
 * 为什么强调「原位置」：`ssh` 的选项是**先到先得**。如果先把主文件的块全读完再追加
 * include 的内容，一个主文件后段重复定义的 `Host dup` 就会顶掉 include 里的版本，
 * 与真实 `ssh` 的行为相反。
 *
 * 读不到的主文件是**硬失败**（异常冒出去，由调用方呈现）；读不到的 `Include` 记问题后继续——
 * OpenSSH 也「当它不存在」，但那会让人以为配置生效了，所以必须报出来。
 */
export declare function readSshConfig(options: ReadSshConfigOptions): {
    readonly parsed: ParsedSshConfig;
    readonly problems: readonly SshConfigProblem[];
    readonly files: readonly string[];
};
//# sourceMappingURL=config.d.ts.map