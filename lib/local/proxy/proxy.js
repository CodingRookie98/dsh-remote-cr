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
import { createServer } from 'node:http';
import { looksLikePlaceholder, substitutePlaceholder } from "./placeholder.js";
/**
 * 唯一允许的监听地址。
 *
 * 绑 `0.0.0.0` 会让局域网内任何主机借这条隧道消耗额度（`architecture.md` §7 安全约束）；
 * 绑某块具体宿主网卡属未决事项（ADR-0002 ② 复活条件第二条），所以这里**不是配置项**。
 */
export const PROXY_BIND_HOST = '127.0.0.1';
/** 回环地址白名单；除了它们，任何绑定地址都在启动前就被挡下。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
/** 启动前校验绑定地址，非法直接抛。 */
export function assertLoopbackBind(host) {
    if (!LOOPBACK_HOSTS.has(host)) {
        throw new Error(`proxy: refusing to listen on "${host}"; the credential proxy only binds loopback`);
    }
}
/** 会被替换的凭据类头（小写）。列表之外的头一律不碰。 */
export const CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'x-dsh-auth-token', 'api-key', 'x-goog-api-key'];
/** 逐跳头：不该转发给上游。 */
const HOP_BY_HOP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authorization']);
/** 由路径解析 provider：`/anthropic/...` 与 `/r/<provider>/...` 两种形态。 */
export function parseProxyPath(pathname) {
    const segments = pathname.split('/').filter((part) => part !== '');
    const [head, second, ...tail] = segments;
    if (head === 'anthropic')
        return { provider: 'anthropic', rest: ['', ...(second === undefined ? [] : [second, ...tail])].join('/') };
    if (head === 'r' && second !== undefined && second !== '')
        return { provider: second, rest: ['', ...tail].join('/') };
    return undefined;
}
/** 从头里取出令牌部分（去掉 `Bearer ` 之类前缀），用于「是不是占位串」的判定。 */
export function tokenOf(rawValue) {
    const match = /^(?:Bearer|Token|ApiKey)\s+(?<token>\S+)$/i.exec(rawValue.trim());
    return (match?.groups?.['token'] ?? rawValue.trim());
}
export class CredentialProxy {
    #options;
    #records = [];
    #warnings = [];
    #maxRecords;
    #server;
    #port;
    constructor(options) {
        this.#options = options;
        this.#maxRecords = options.maxRecords ?? 500;
    }
    /** 实际监听端口；未启动时为 `undefined`。 */
    get port() {
        return this.#port;
    }
    /** 最近若干条入站记录（新→旧）。 */
    records() {
        return [...this.#records];
    }
    /** 最近若干条告警（新→旧）。 */
    warnings() {
        return [...this.#warnings];
    }
    async start() {
        if (this.#server !== undefined)
            throw new Error('proxy: already started');
        assertLoopbackBind(PROXY_BIND_HOST);
        const server = createServer((req, res) => {
            void this.#handle(req, res);
        });
        this.#server = server;
        const port = await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(this.#options.port, PROXY_BIND_HOST, () => {
                const address = server.address();
                if (address === null || typeof address === 'string')
                    reject(new Error('proxy: unexpected listen address'));
                else
                    resolve(address.port);
            });
        });
        this.#port = port;
        return port;
    }
    async stop() {
        const server = this.#server;
        this.#server = undefined;
        this.#port = undefined;
        if (server === undefined)
            return;
        await new Promise((resolve) => server.close(() => resolve()));
    }
    #warn(code, message) {
        const warning = { at: new Date().toISOString(), code, message };
        this.#warnings.unshift(warning);
        if (this.#warnings.length > this.#maxRecords)
            this.#warnings.length = this.#maxRecords;
        this.#options.onWarning?.(warning);
    }
    #record(record) {
        this.#records.unshift(record);
        if (this.#records.length > this.#maxRecords)
            this.#records.length = this.#maxRecords;
    }
    async #handle(req, res) {
        const at = new Date().toISOString();
        const remoteHeader = req.headers['x-teleport-host'];
        const remote = typeof remoteHeader === 'string' && remoteHeader !== '' ? remoteHeader : (req.socket.remoteAddress ?? 'unknown');
        const pathname = new URL(req.url ?? '/', 'http://proxy.invalid').pathname;
        if (pathname === '/healthz') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, placeholders: this.#options.table.size }));
            return;
        }
        const parsed = parseProxyPath(pathname);
        if (parsed === undefined) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 'proxy/unknown-route', message: `no route for ${pathname}` } }));
            this.#record({ at, remote, method: req.method ?? 'GET', provider: 'unknown', path: pathname, status: 404, outcome: 'rejected', substitutions: [], upstream: '', reason: 'unknown-route' });
            return;
        }
        // ---- 第 1 步：凭据类头必须是占位串，否则这台远端已经拿到真钥匙了 ----
        for (const name of CREDENTIAL_HEADERS) {
            const raw = req.headers[name];
            if (raw === undefined)
                continue;
            const value = Array.isArray(raw) ? raw[0] : raw;
            if (value === undefined || value.trim() === '')
                continue;
            const token = tokenOf(value);
            if (looksLikePlaceholder(token))
                continue;
            const message = `proxy: request carries a non-placeholder value in "${name}"; refusing to forward it upstream`;
            this.#warn('proxy/real-credential-on-remote', message);
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 'proxy/real-credential-on-remote', message } }));
            this.#record({ at, remote, method: req.method ?? 'GET', provider: parsed.provider, path: pathname, status: 403, outcome: 'rejected', substitutions: [], upstream: '', reason: 'real-credential-on-remote' });
            return;
        }
        // ---- 第 2 步：替换。取不到真值就失败，绝不把占位串发上游 ----
        const substitutions = [];
        const headers = new Headers();
        for (const [name, raw] of Object.entries(req.headers)) {
            if (raw === undefined)
                continue;
            const lower = name.toLowerCase();
            if (HOP_BY_HOP.has(lower) || lower === 'content-length' || lower === 'x-teleport-host')
                continue;
            const values = Array.isArray(raw) ? raw : [raw];
            for (const value of values) {
                if (!CREDENTIAL_HEADERS.includes(lower)) {
                    headers.append(name, value);
                    continue;
                }
                try {
                    const result = await substitutePlaceholder(value, this.#options.table, (ref) => this.#options.credentials.resolve(ref));
                    headers.append(name, result.value);
                    if (result.ref !== undefined)
                        substitutions.push({ header: lower, ref: result.ref });
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    this.#warn('proxy/credential-unresolved', message);
                    res.writeHead(502, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ error: { code: 'proxy/credential-unresolved', message } }));
                    this.#record({ at, remote, method: req.method ?? 'GET', provider: parsed.provider, path: pathname, status: 502, outcome: 'rejected', substitutions, upstream: '', reason: 'credential-unresolved' });
                    return;
                }
            }
        }
        // ---- 第 3 步：转发 ----
        const base = this.#options.resolveUpstream(parsed.provider);
        if (base === undefined) {
            const message = `proxy: no upstream configured for provider "${parsed.provider}"`;
            this.#warn('proxy/upstream-unknown', message);
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 'proxy/upstream-unknown', message } }));
            this.#record({ at, remote, method: req.method ?? 'GET', provider: parsed.provider, path: pathname, status: 502, outcome: 'upstream-error', substitutions, upstream: '', reason: 'upstream-unknown' });
            return;
        }
        const upstream = new URL(parsed.rest.replace(/^\//, ''), base.endsWith('/') ? base : `${base}/`);
        const method = req.method ?? 'GET';
        const hasBody = method !== 'GET' && method !== 'HEAD';
        const fetchImpl = this.#options.fetchImpl ?? fetch;
        let response;
        try {
            response = await fetchImpl(upstream, {
                method,
                headers,
                ...(hasBody ? { body: req, duplex: 'half' } : {}),
                redirect: 'manual',
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.#warn('proxy/upstream-unreachable', `${upstream.origin}: ${message}`);
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 'proxy/upstream-unreachable', message } }));
            this.#record({ at, remote, method, provider: parsed.provider, path: pathname, status: 502, outcome: 'upstream-error', substitutions, upstream: upstream.toString(), reason: 'upstream-unreachable' });
            return;
        }
        const outHeaders = {};
        response.headers.forEach((value, name) => {
            if (HOP_BY_HOP.has(name) || name === 'content-encoding' || name === 'content-length')
                return;
            outHeaders[name] = value;
        });
        res.writeHead(response.status, outHeaders);
        if (response.body === null) {
            res.end();
        }
        else {
            for await (const chunk of response.body)
                res.write(chunk);
            res.end();
        }
        this.#record({ at, remote, method, provider: parsed.provider, path: pathname, status: response.status, outcome: 'ok', substitutions, upstream: upstream.toString() });
    }
}
//# sourceMappingURL=proxy.js.map