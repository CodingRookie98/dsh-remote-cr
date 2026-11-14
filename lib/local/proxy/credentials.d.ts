/**
 * 本地凭据来源（P3.6 的「真值从哪来」半边）。
 *
 * `docs/design/architecture.md` §7 定了取值优先级：
 *   1. 本地进程环境变量
 *   2. 本地 `$DSH_HOME/.credentials.yaml` 的 `refs`
 *   3. 账号 grant token（`records.deepseek-account-platform/default`）
 *
 * 这里实现 1 与 2（3 是账号级令牌，不是逐 ref 的密钥，单独由 `accountGrant()` 暴露）。
 *
 * **刻意不引入 YAML 解析库**：官方文档的 schema 是固定的三段
 * （`version` / `records` / `refs`），而 `refs` 只允许 POSIX 标识符键 + 非空字符串值
 * （`packages/credentials/credentials-local/src/index.ts:271-274`）。写一个只认这一段
 * 的窄解析器，比把整份含密钥的文件交给通用 YAML 解析器更可控 —— 后者会为支持
 * 锚点/标签/多文档而读入并可能重新序列化本不该外流的内容。
 */
/** 与官方实现同名同值：`packages/credentials/credentials-local/src/index.ts:61`。 */
export declare const CREDENTIALS_FILENAME = ".credentials.yaml";
/** 解析结果：只保留 `refs`（以及账号级 grant token），records 里的密钥不进这个结构。 */
export interface CredentialDocument {
    readonly version: number;
    readonly refs: ReadonlyMap<string, string>;
}
/** 解析失败时抛这个，调用方据此走正式失败通道而不是静默当没配。 */
export declare class CredentialsDocumentError extends Error {
    constructor(message: string);
}
/**
 * 从 `.credentials.yaml` 文本里取出 `refs` 段。
 *
 * 只做「顶层 section 切换 + 缩进层级」的浅解析：`refs:` 之后所有缩进一级的行都是
 * 一个 ref；遇到不缩进的行说明该段结束。空行与 `#` 注释跳过。
 */
export declare function parseCredentialRefs(text: string): CredentialDocument;
/**
 * 权限判定本体（纯函数，便于在 Windows 上也能测）。
 *
 * 与官方 `assertOwnerOnly` 同口径：只要有组/其他用户权限位就拒绝。Windows 的
 * `stat().mode` 恒为 `0o666` 之类，不代表真实 ACL，所以**只在 POSIX 上实际执行**。
 */
export declare function assertOwnerOnlyMode(mode: number, path: string): void;
/** `$DSH_HOME` 的解析：显式传参 > `DSH_HOME` 环境变量 > `~/.dsh`。 */
export declare function resolveDshHome(explicit?: string, env?: NodeJS.ProcessEnv): string;
/** 本地凭据集合：环境变量优先，其次 `.credentials.yaml` 的 `refs`。 */
export declare class LocalCredentials {
    #private;
    constructor(options?: {
        env?: NodeJS.ProcessEnv;
        refs?: ReadonlyMap<string, string>;
        sourcePath?: string;
    });
    /** 读本地凭据文件。文件不存在不是错误（只用环境变量也能跑），但**存在却坏掉**要抛。 */
    static load(options?: {
        dshHome?: string;
        env?: NodeJS.ProcessEnv;
        filename?: string;
    }): Promise<LocalCredentials>;
    /** 这个 ref 在本地是否有值（不泄露值本身）。 */
    has(ref: string): boolean;
    /** 同步取值：环境变量优先，其次文件 `refs`。 */
    resolveSync(ref: string): string | undefined;
    /** 异步形态，供 `substitutePlaceholder` 的 `resolve` 回调直接使用。 */
    resolve(ref: string): Promise<string | undefined>;
    /** 所有已知 ref 名（环境变量里像密钥的那些也算），顺序稳定。 */
    refs(): string[];
    /** 凭据文件的路径；只用了环境变量时为 `undefined`。 */
    get sourcePath(): string | undefined;
}
//# sourceMappingURL=credentials.d.ts.map