/**
 * 凭据代理的装配：把「表 / 凭据 / 上游」三样拼成一个能起停的运行时。
 *
 * 为什么要有这一层：`CredentialProxy` 自己只做「收请求 → 换占位串 → 转发」，
 * 它刻意不知道凭据从哪来、上游是谁、远端该拿到哪些占位串。这三件事属于部署决定，
 * 单独放一层以后，真机探针与插件入口能装同一份逻辑（探针里换上游为假服务即可），
 * 不必在每处各写一遍。
 *
 * **salt 必须跨进程稳定**：`mintPlaceholder(ref, salt)` 是纯函数，salt 一变占位串就变；
 * 远端磁盘上的 provider 配置里写着占位串，重启后对不上等于远端拿到一把作废的钥匙。
 * 所以默认 salt 是固定串而不是随机数 —— 占位串的强度来自 ref 的取值空间（SHA-256 前 96 bit），
 * 不需要 salt 保密。
 */
import { LocalCredentials } from './credentials.ts';
import { PlaceholderTable } from './placeholder.ts';
import { CredentialProxy } from './proxy.ts';
/** 默认 salt；改它等于让所有远端已写下的占位串作废。 */
export declare const DEFAULT_PROXY_SALT = "dsh-remote-cr/proxy/v1";
/** 内置上游地址：只放「官方端点」这种不会引起歧义的常量，其余一律由调用方给。 */
export declare const DEFAULT_UPSTREAMS: Readonly<Record<string, string>>;
/** 上游覆盖用的环境变量前缀：`REMOTE_CR_UPSTREAM_DEEPSEEK=https://…`。 */
export declare const UPSTREAM_ENV_PREFIX = "REMOTE_CR_UPSTREAM_";
/** 由环境变量 + 内置表解析上游；返回 `undefined` 表示没配，请求按 upstream-error 收口。 */
export declare function resolveUpstreamFromEnv(provider: string, env?: NodeJS.ProcessEnv): string | undefined;
export interface CredentialProxyRuntime {
    readonly proxy: CredentialProxy;
    readonly port: number;
    readonly table: PlaceholderTable;
    /** ref → 占位串。远端环境要注入的就是这份；**不含任何真值**。 */
    readonly env: Readonly<Record<string, string>>;
    stop(): Promise<void>;
}
export interface StartCredentialProxyOptions {
    readonly credentials: LocalCredentials;
    readonly resolveUpstream: (provider: string) => string | undefined;
    /** 监听端口；缺省 0（由内核挑），真机上插件入口用缺省值。 */
    readonly port?: number;
    /** 覆盖 salt；测试用。 */
    readonly salt?: string;
    /** 只登记这些 ref；缺省登记凭据里已知的全部。 */
    readonly refs?: readonly string[];
    readonly fetchImpl?: typeof fetch;
    readonly maxRecords?: number;
}
/**
 * 起一个本地凭据代理，并把「远端该拿到哪些占位串」一起算好。
 *
 * 登记全部已知 ref 而不是只登记当前用到的那一个：远端 provider 的 `apiKeyEnv` 是用户在
 * 远端配置里写的名字，本地无从得知；漏登记会让远端拿到一个未绑定的占位串，代理侧报
 * `placeholder-unknown`，而用户看到的只是「模型请求失败」。多登记几个只在内存里多几条映射。
 */
export declare function startCredentialProxy(options: StartCredentialProxyOptions): Promise<CredentialProxyRuntime>;
//# sourceMappingURL=runtime.d.ts.map