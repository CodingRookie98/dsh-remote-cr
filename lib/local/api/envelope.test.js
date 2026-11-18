import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteCrError } from "../backend/errors.js";
import { MAX_BODY_BYTES, errorEnvelope, isLoopbackRequest, okEnvelope, readJsonBody, sendJson, sendMethodNotAllowed } from "./envelope.js";
function fakeResponse() {
    const headers = {};
    const state = { statusCode: 0, body: '' };
    const res = {
        set statusCode(value) {
            state.statusCode = value;
        },
        get statusCode() {
            return state.statusCode;
        },
        setHeader(name, value) {
            headers[name.toLowerCase()] = value;
        },
        end(chunk) {
            state.body = chunk ?? '';
        },
    };
    return { res: res, headers, state };
}
function fakeRequest(chunks, address = '127.0.0.1') {
    let destroyed = false;
    const req = {
        socket: { remoteAddress: address },
        async *[Symbol.asyncIterator]() {
            for (const chunk of chunks)
                yield Buffer.from(chunk);
        },
        destroy() {
            destroyed = true;
        },
    };
    return { req: req, wasDestroyed: () => destroyed };
}
test('成功信封只有一个 value 字段', () => {
    assert.deepEqual(okEnvelope({ a: 1 }), { ok: true, value: { a: 1 } });
});
test('RemoteCrError 四字段原样透出，不被折叠成 unknown', () => {
    const envelope = errorEnvelope(new RemoteCrError({
        code: 'remote/path-unreadable',
        detail: 'D:\\nope 不可读',
        nextActions: ['换一个目录'],
        logTail: 'EACCES',
    }));
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 'remote/path-unreadable');
    assert.equal(envelope.detail, 'D:\\nope 不可读');
    assert.deepEqual(envelope.nextActions, ['换一个目录']);
});
test('可照抄命令与远端原文随信封出去（客户端会覆盖 nextActions，这两项不能丢）', () => {
    const envelope = errorEnvelope(new RemoteCrError({
        code: 'remote/host-upgrade-failed',
        detail: '安装失败',
        nextActions: ['重试'],
        command: "npm install --global --prefix '/s/npm' '@deepseek-ai/dsh@0.2.2-rc.4'",
        logTail: 'npm ERR! code EACCES',
    }));
    assert.match(String(envelope.command), /--prefix '\/s\/npm'/);
    assert.match(String(envelope.logTail), /EACCES/);
    // 没有命令时不要凭空造一个空字符串字段（客户端据此判 null）。
    const plain = errorEnvelope(new RemoteCrError({ code: 'remote/unknown', detail: 'x', nextActions: ['重试'] }));
    assert.equal(plain.command, undefined);
    assert.equal(plain.logTail, undefined);
});
test('普通异常归到 remote/unknown，但仍有一句可读原因与下一步', () => {
    const envelope = errorEnvelope(new Error('boom'));
    assert.equal(envelope.code, 'remote/unknown');
    assert.equal(envelope.detail, 'boom');
    assert.ok(envelope.nextActions.length > 0);
});
test('只有本机回环放行，局域网地址一律拒绝', () => {
    const at = (address) => isLoopbackRequest({ socket: { remoteAddress: address } });
    assert.equal(at('127.0.0.1'), true);
    assert.equal(at('::1'), true);
    assert.equal(at('::ffff:127.0.0.1'), true);
    assert.equal(at('192.168.1.10'), false);
    assert.equal(at('::ffff:192.168.1.10'), false);
    assert.equal(at(undefined), false);
});
test('sendJson 写 no-store 与 JSON content-type（缓存会显示过期状态）', () => {
    const { res, headers, state } = fakeResponse();
    sendJson(res, 200, { ok: true });
    assert.equal(state.statusCode, 200);
    assert.equal(headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(headers['cache-control'], 'no-store');
    assert.equal(state.body, '{"ok":true}');
});
test('405 带 allow 头，且 body 仍是错误信封', () => {
    const { res, headers, state } = fakeResponse();
    sendMethodNotAllowed(res, ['GET']);
    assert.equal(state.statusCode, 405);
    assert.equal(headers['allow'], 'GET');
    assert.equal(JSON.parse(state.body).ok, false);
});
test('读 JSON body：空体给 undefined，非 JSON 抛结构化错误', async () => {
    assert.equal(await readJsonBody(fakeRequest([]).req), undefined);
    assert.deepEqual(await readJsonBody(fakeRequest(['{"a":', '1}']).req), { a: 1 });
    await assert.rejects(() => readJsonBody(fakeRequest(['not json']).req), /请求体不是合法 JSON/);
});
test('超过上限立刻断开连接并抛错（不把内存交给对方）', async () => {
    const big = 'x'.repeat(MAX_BODY_BYTES + 1);
    const request = fakeRequest([big]);
    await assert.rejects(() => readJsonBody(request.req), /超过/);
    assert.equal(request.wasDestroyed(), true);
});
test('NEGATIVE_CONTROL 可假性：把回环判定放宽到任意地址必须让断言失败', () => {
    const negate = process.env.NEGATIVE_CONTROL === '1';
    const address = negate ? '192.168.1.10' : '::1';
    assert.equal(isLoopbackRequest({ socket: { remoteAddress: address } }), true);
});
//# sourceMappingURL=envelope.test.js.map