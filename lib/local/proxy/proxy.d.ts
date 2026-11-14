/**
 * 本地凭据代理：远端 LLM 请求的落地点，唯一允许出现真值的地方。
 *
 * 三条硬约束（`docs/design/architecture.md` §7、铁律 3）：
 * 1. **只绑 `127.0.0.1`**。绑 `0.0.0.0` 会让整条局域网都能借隧道烧额度；绑某块具体宿主
 *    网卡属未决事项（ADR-0002 复活条件第二条），本模块直接拒绝任何非回环地址。
 * 2. **只认占位串**。任何凭据类头如果带的是非占位串（也就是「真 key 被同步到远端」这个
 *    事故），一律 403 挡下并留证据 —— 这是本模块最重要的护栏。
 * 3. **每次请求都留结构化记录**：远端 host、命中的 ref、上游、状态码。A6 的验收口径要求
 *    「本机代理侧有该远端 host 的真实入站请求记录 + 占位令牌替换日志」，就在这里产生。
 */
import type { LocalCredentials } from './credentials.ts';
import { PlaceholderTable } from './placeholder.ts';
/**
 * 唯一允许的监听地址。
 *
 * 绑 `0.0.0.0` 会让局域网内任何主机借这条隧道消耗额度（`architecture.md` §7 安全约束）；
 * 绑某块具体宿主网卡属未决事项（ADR-0002 ② 复活条件第二条），所以这里**不是配置项**。
 */
export declare const PROXY_BIND_HOST = "127.0.0.1";
/** 启动前校验绑定地址，非法直接抛。 */
export declare function assertLoopbackBind(host: string): void;
/** 会被替换的凭据类头（小写）。列表之外的头一律不碰。 */
export declare const CREDENTIAL_HEADERS: readonly ["authorization", "x-api-key", "x-dsh-auth-token", "api-key", "x-goog-api-key"];
/** 一次替换的证据。 */
export interface SubstitutionRecord {
    readonly header: string;
    readonly ref: string;
}
/** 一条入站请求的完整记录。 */
export interface ProxyRecord {
    readonly at: string;
    /** 发起该请求的远端环境标识（远端 patch 注入的 `x-teleport-host`，缺省回落 socket 地址）。 */
    readonly remote: string;
    readonly method: string;
    readonly provider: string;
    readonly path: string;
    readonly status: number;
    readonly outcome: 'ok' | 'rejected' | 'upstream-error';
    readonly substitutions: readonly SubstitutionRecord[];
    readonly upstream: string;
    /** 拒绝原因；`ok` 时缺省。 */
    readonly reason?: string;
}
/** 结构化告警，进状态面板。 */
export interface ProxyWarning {
    readonly at: string;
    readonly code: string;
    readonly message: string;
}
export interface ProxyOptions {
    /** 端口；`0` 表示由系统分配（测试用）。 */
    readonly port: number;
    readonly table: PlaceholderTable;
    readonly credentials: LocalCredentials;
    /**
     * provider id → 上游 base URL。返回 `undefined` 表示这个 provider 未配置，
     * 请求按 `upstream-error` 收口而不是猜一个默认地址。
     */
    readonly resolveUpstream: (provider: string) => string | undefined;
    /** 记录上限；只保留最近 N 条，防止长时间运行吃内存。 */
    readonly maxRecords?: number;
    /** 允许注入的 fetch（测试里替换成假上游）。 */
    readonly fetchImpl?: typeof fetch;
    /** 告警回调；不传时静默收集，可经 `warnings()` 读出。 */
    readonly onWarning?: (warning: ProxyWarning) => void;
}
/** 由路径解析 provider：`/anthropic/...` 与 `/r/<provider>/...` 两种形态。 */
export declare function parseProxyPath(pathname: string): {
    provider: string;
    rest: string;
} | undefined;
/** 从头里取出令牌部分（去掉 `Bearer ` 之类前缀），用于「是不是占位串」的判定。 */
export declare function tokenOf(rawValue: string): string;
export declare class CredentialProxy {
    #private;
    constructor(options: ProxyOptions);
    /** 实际监听端口；未启动时为 `undefined`。 */
    get port(): number | undefined;
    /** 最近若干条入站记录（新→旧）。 */
    records(): readonly ProxyRecord[];
    /** 最近若干条告警（新→旧）。 */
    warnings(): readonly ProxyWarning[];
    start(): Promise<number>;
    stop(): Promise<void>;
}
//# sourceMappingURL=proxy.d.ts.map