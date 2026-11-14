import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectionGate, SyncBarrier } from "./barrier.js";
const NEG = process.env.NEGATIVE_CONTROL === '1';
const HOST = 'wsl:ubuntu_dev';
function writeReturning(outcome, detail) {
    const calls = [];
    const write = async (host) => {
        calls.push(host);
        return detail === undefined ? { outcome } : { outcome, detail };
    };
    return { write, calls };
}
function barrierWith(write, published = false) {
    const warnings = [];
    const barrier = new SyncBarrier({
        write,
        isPublished: () => published,
        onWarning: (warning) => warnings.push(warning.code),
        now: () => new Date('2026-10-31T05:00:00.000Z'),
    });
    return { barrier, warnings };
}
test('applied / already-applied 都算屏障已过，且不发告警', async () => {
    for (const outcome of ['applied', 'already-applied']) {
        const { write } = writeReturning(outcome);
        const { barrier, warnings } = barrierWith(write, true);
        const result = await barrier.ensure(HOST);
        // NEGATIVE_CONTROL: 把 passed 判定反成 blocked，两条都必须红。
        assert.equal(result.verdict, NEG ? 'blocked' : 'passed');
        assert.equal(result.outcome, outcome);
        assert.deepEqual(warnings, []);
        assert.deepEqual(connectionGate(result), { publish: 'online' });
    }
});
test('failed / unsupported 未发布时给 failed 且 retryable，不发布 online', async () => {
    const { write } = writeReturning('failed', 'disk read-only');
    const { barrier, warnings } = barrierWith(write, false);
    const result = await barrier.ensure(HOST);
    assert.equal(result.verdict, 'blocked');
    assert.equal(result.detail, 'disk read-only');
    const gate = connectionGate(result);
    assert.equal(gate.publish, 'failed');
    assert.equal(gate.publish === 'failed' && gate.retryable, true);
    assert.equal(gate.publish === 'failed' && gate.code, 'proxy/sync-failed');
    // 未发布时不应发「发布后失败」告警 —— 那是失败通道的活，不是 warning。
    assert.deepEqual(warnings, []);
    const unsupported = await barrierWith(writeReturning('unsupported').write, false).barrier.ensure(HOST);
    const unsupportedGate = connectionGate(unsupported);
    // NEGATIVE_CONTROL: 把 unsupported 与 failed 的错误码混为一谈，这里必红。
    assert.equal(unsupportedGate.publish === 'failed' && unsupportedGate.code, NEG ? 'proxy/sync-failed' : 'proxy/sync-unsupported');
});
test('同一 host 并发调用共享一个 flight（单飞）', async () => {
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    let calls = 0;
    const barrier = new SyncBarrier({
        write: async () => {
            calls += 1;
            await gate;
            return { outcome: 'applied' };
        },
        isPublished: () => false,
    });
    const first = barrier.ensure(HOST);
    const second = barrier.ensure(HOST);
    const third = barrier.ensure(HOST);
    assert.equal(barrier.inFlight(HOST), true);
    assert.equal(first, second);
    assert.equal(second, third);
    release?.();
    const [a, b, c] = await Promise.all([first, second, third]);
    assert.equal(a.outcome, 'applied');
    assert.equal(b, a);
    assert.equal(c, a);
    assert.equal(calls, 1);
});
test('flight 结束后不缓存结论，下一次连接必须重新过屏障', async () => {
    const { write, calls } = writeReturning('applied');
    const { barrier } = barrierWith(write);
    await barrier.ensure(HOST);
    assert.equal(barrier.inFlight(HOST), false);
    await barrier.ensure(HOST);
    // NEGATIVE_CONTROL: 若把 barrier 当成一次性初始化（缓存结论），第二次就不再写入，这里必红。
    assert.equal(calls.length, NEG ? 1 : 2);
});
test('不同 host 各自单飞，互不阻塞', async () => {
    const seen = [];
    const barrier = new SyncBarrier({
        write: async (host) => {
            seen.push(host);
            return { outcome: 'applied' };
        },
        isPublished: () => false,
    });
    await Promise.all([barrier.ensure('wsl:a'), barrier.ensure('ssh:b')]);
    // NEGATIVE_CONTROL: 若把飞行表做成全局单例，第二个 host 会被串行化甚至丢写，这里必红。
    assert.deepEqual(seen.slice().sort(), NEG ? ['wsl:a'] : ['ssh:b', 'wsl:a']);
});
test('已发布之后失败只留结构化 warning，不改裁决、不拆连接', async () => {
    const { write } = writeReturning('failed', 'remote umask changed it');
    const { barrier, warnings } = barrierWith(write, true);
    const result = await barrier.ensure(HOST);
    assert.equal(result.verdict, 'blocked');
    assert.deepEqual(warnings, ['sync-failed']);
    const [warning] = barrier.warnings();
    assert.equal(warning?.host, HOST);
    assert.equal(warning?.at, '2026-10-31T05:00:00.000Z');
    // 关键语义：警告不等于判连接失败 —— 已发布的连接由调用方保持 online。
    assert.match(warning?.message ?? '', /after the connection was published/);
});
test('unsupported 在已发布后记为 sync-unsupported', async () => {
    const { barrier, warnings } = barrierWith(writeReturning('unsupported').write, true);
    await barrier.ensure(HOST);
    assert.deepEqual(warnings, [NEG ? 'sync-failed' : 'sync-unsupported']);
});
test('写入抛异常等价 failed，不能当成已通过', async () => {
    const barrier = new SyncBarrier({
        write: async () => {
            throw new Error('wsl.exe exited with code 5');
        },
        isPublished: () => false,
    });
    const result = await barrier.ensure(HOST);
    assert.equal(result.verdict, 'blocked');
    assert.equal(result.outcome, 'failed');
    assert.equal(result.detail, 'wsl.exe exited with code 5');
    assert.equal(barrier.lastResult(HOST), result);
});
test('lastResult 反映最近一次结论，从未跑过时为 undefined', async () => {
    const { write } = writeReturning('applied');
    const { barrier } = barrierWith(write);
    assert.equal(barrier.lastResult('wsl:other'), undefined);
    await barrier.ensure(HOST);
    assert.equal(barrier.lastResult(HOST)?.outcome, 'applied');
});
test('connectionGate 对 passed 只给 online，不带任何错误字段', () => {
    const gate = connectionGate({ host: HOST, verdict: NEG ? 'blocked' : 'passed', outcome: 'applied' });
    assert.deepEqual(gate, NEG ? { publish: 'online', retryable: undefined } : { publish: 'online' });
});
//# sourceMappingURL=barrier.test.js.map