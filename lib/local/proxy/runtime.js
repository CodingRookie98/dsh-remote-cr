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
import { PlaceholderTable } from "./placeholder.js";
import { CredentialProxy } from "./proxy.js";
/** 默认 salt；改它等于让所有远端已写下的占位串作废。 */
export const DEFAULT_PROXY_SALT = 'dsh-teleport/proxy/v1';
/** 内置上游地址：只放「官方端点」这种不会引起歧义的常量，其余一律由调用方给。 */
export const DEFAULT_UPSTREAMS = {
    anthropic: 'https://api.anthropic.com',
    deepseek: 'https://api.deepseek.com',
};
/** 上游覆盖用的环境变量前缀：`TELEPORT_UPSTREAM_DEEPSEEK=https://…`。 */
export const UPSTREAM_ENV_PREFIX = 'TELEPORT_UPSTREAM_';
/** 由环境变量 + 内置表解析上游；返回 `undefined` 表示没配，请求按 upstream-error 收口。 */
export function resolveUpstreamFromEnv(provider, env = process.env) {
    const key = UPSTREAM_ENV_PREFIX + provider.toUpperCase().replaceAll('-', '_');
    const fromEnv = env[key];
    if (fromEnv !== undefined && fromEnv.trim() !== '')
        return fromEnv.trim();
    return DEFAULT_UPSTREAMS[provider];
}
/**
 * 起一个本地凭据代理，并把「远端该拿到哪些占位串」一起算好。
 *
 * 登记全部已知 ref 而不是只登记当前用到的那一个：远端 provider 的 `apiKeyEnv` 是用户在
 * 远端配置里写的名字，本地无从得知；漏登记会让远端拿到一个未绑定的占位串，代理侧报
 * `placeholder-unknown`，而用户看到的只是「模型请求失败」。多登记几个只在内存里多几条映射。
 */
export async function startCredentialProxy(options) {
    const table = new PlaceholderTable(options.salt ?? DEFAULT_PROXY_SALT);
    const refs = options.refs ?? options.credentials.refs();
    const env = {};
    for (const ref of refs) {
        if (!options.credentials.has(ref))
            continue;
        env[ref] = table.register(ref);
    }
    const proxy = new CredentialProxy({
        port: options.port ?? 0,
        table,
        credentials: options.credentials,
        resolveUpstream: options.resolveUpstream,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(options.maxRecords === undefined ? {} : { maxRecords: options.maxRecords }),
    });
    const port = await proxy.start();
    let stopped = false;
    return {
        proxy,
        port,
        table,
        env: Object.freeze({ ...env }),
        async stop() {
            if (stopped)
                return;
            stopped = true;
            await proxy.stop();
        },
    };
}
//# sourceMappingURL=runtime.js.map