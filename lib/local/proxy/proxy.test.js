import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { CredentialProxy, PROXY_BIND_HOST, assertLoopbackBind, parseProxyPath, tokenOf } from "./proxy.js";
import { PlaceholderTable } from "./placeholder.js";
import { LocalCredentials } from "./credentials.js";
const SALT = 'proxy-test-salt';
/** 假上游：把收到的头原样回吐，便于断言「上游到底看到了什么」。 */
async function startFakeUpstream() {
    const seen = [];
    const server = createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            seen.push({ path: req.url ?? '/', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, path: req.url }));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = server.address().port;
    return { server, base: `http://127.0.0.1:${port}`, seen };
}
function makeProxy(table, upstreamBase, credentials) {
    return new CredentialProxy({
        port: 0,
        table,
        credentials: credentials ?? new LocalCredentials({ env: {}, refs: new Map() }),
        resolveUpstream: (provider) => (provider === 'deepseek' || provider === 'anthropic' ? upstreamBase : undefined),
    });
}
test('parseProxyPath 认 /anthropic 与 /r/<provider> 两种形态，其余拒绝', () => {
    assert.deepEqual(parseProxyPath('/anthropic/v1/messages'), { provider: 'anthropic', rest: '/v1/messages' });
    assert.deepEqual(parseProxyPath('/r/deepseek/chat/completions'), { provider: 'deepseek', rest: '/chat/completions' });
    assert.equal(parseProxyPath('/'), undefined);
    assert.equal(parseProxyPath('/healthz'), undefined);
    assert.equal(parseProxyPath('/r/'), undefined);
});
test('tokenOf 去掉 Bearer 前缀，裸值原样返回', () => {
    assert.equal(tokenOf('Bearer abc'), 'abc');
    assert.equal(tokenOf('abc'), 'abc');
    assert.equal(tokenOf('  Token xyz  '), 'xyz');
});
test('占位串被换成真值再发给上游，且逐条登记替换记录', async () => {
    const upstream = await startFakeUpstream();
    const table = new PlaceholderTable(SALT);
    const placeholder = table.register('DEEPSEEK_API_KEY');
    const credentials = new LocalCredentials({ env: {}, refs: new Map([['DEEPSEEK_API_KEY', 'sk-real-value']]) });
    const proxy = makeProxy(table, upstream.base, credentials);
    const port = await proxy.start();
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
    const response = await fetch(`http://127.0.0.1:${port}/r/deepseek/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${placeholder}`, 'content-type': 'application/json', 'x-teleport-host': 'wsl:ubuntu_dev' },
        body: JSON.stringify({ model: 'x' }),
    });
    assert.equal(response.status, 200);
    // 上游看到的必须已经是真值。
    assert.equal(upstream.seen.length, 1);
    assert.equal(upstream.seen[0]?.headers['authorization'], 'Bearer sk-real-value');
    assert.equal(upstream.seen[0]?.body, '{"model":"x"}');
    // 远端标识是代理自加的，不该外泄给上游。
    assert.equal(upstream.seen[0]?.headers['x-teleport-host'], undefined);
    const record = proxy.records()[0];
    assert.equal(record?.outcome, 'ok');
    assert.equal(record?.remote, 'wsl:ubuntu_dev');
    assert.equal(record?.provider, 'deepseek');
    assert.deepEqual(record?.substitutions, [{ header: 'authorization', ref: 'DEEPSEEK_API_KEY' }]);
    assert.equal(JSON.stringify(proxy.records()).includes('sk-real-value'), false);
    await proxy.stop();
    await new Promise((resolve) => upstream.server.close(() => resolve()));
});
test('远端带非占位串（真钥匙）时 403 挡下，不转发、不泄漏', async () => {
    const upstream = await startFakeUpstream();
    const table = new PlaceholderTable(SALT);
    table.register('DEEPSEEK_API_KEY');
    const proxy = makeProxy(table, upstream.base);
    const port = await proxy.start();
    const response = await fetch(`http://127.0.0.1:${port}/r/deepseek/chat/completions`, {
        headers: { authorization: 'Bearer sk-leaked-real-key', 'x-teleport-host': 'wsl:ubuntu_dev' },
    });
    assert.equal(response.status, 403);
    const body = (await response.json());
    assert.equal(body.error.code, 'proxy/real-credential-on-remote');
    assert.equal(upstream.seen.length, 0, '真钥匙请求绝不能到上游');
    assert.equal(proxy.records()[0]?.outcome, 'rejected');
    assert.equal(proxy.warnings()[0]?.code, 'proxy/real-credential-on-remote');
    await proxy.stop();
    await new Promise((resolve) => upstream.server.close(() => resolve()));
});
test('占位串已登记但本地无值 → 502，且占位串不会被发上游', async () => {
    const upstream = await startFakeUpstream();
    const table = new PlaceholderTable(SALT);
    const placeholder = table.register('MISSING_KEY');
    const proxy = makeProxy(table, upstream.base);
    const port = await proxy.start();
    const response = await fetch(`http://127.0.0.1:${port}/r/deepseek/chat/completions`, {
        headers: { 'x-api-key': placeholder },
    });
    assert.equal(response.status, 502);
    assert.equal(upstream.seen.length, 0);
    assert.equal(proxy.warnings()[0]?.code, 'proxy/credential-unresolved');
    await proxy.stop();
    await new Promise((resolve) => upstream.server.close(() => resolve()));
});
test('未配置的 provider 与未知路由各有明确状态码，不猜上游', async () => {
    const table = new PlaceholderTable(SALT);
    const proxy = makeProxy(table, 'http://127.0.0.1:1');
    const port = await proxy.start();
    assert.equal((await fetch(`http://127.0.0.1:${port}/r/mystery/chat`)).status, 502);
    assert.equal((await fetch(`http://127.0.0.1:${port}/not-a-route`)).status, 404);
    assert.deepEqual(proxy.records().map((r) => r.outcome), ['rejected', 'upstream-error']);
    await proxy.stop();
});
test('绑定地址白名单：回环放行，0.0.0.0 与网卡地址一律拒绝', () => {
    assert.doesNotThrow(() => assertLoopbackBind('127.0.0.1'));
    assert.doesNotThrow(() => assertLoopbackBind('::1'));
    assert.throws(() => assertLoopbackBind('0.0.0.0'), /refusing to listen on "0\.0\.0\.0"/);
    assert.throws(() => assertLoopbackBind('192.168.1.10'), /refusing to listen on "192\.168\.1\.10"/);
});
test('NEGATIVE_CONTROL 可假性：把绑定地址改成 0.0.0.0 必须让「只绑回环」断言失败', () => {
    // 变异点：最典型的事故 —— 为了「让 distro 也能连」把代理绑到通配地址。
    const bindHost = process.env.NEGATIVE_CONTROL === '1' ? '0.0.0.0' : PROXY_BIND_HOST;
    assert.doesNotThrow(() => assertLoopbackBind(bindHost));
});
//# sourceMappingURL=proxy.test.js.map