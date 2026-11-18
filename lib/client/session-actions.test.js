import assert from 'node:assert/strict';
import test from 'node:test';
import { clearSessionActionFailure, lastSessionActionFailure, requestReconnect, subscribeSessionActions, } from "./session-actions.js";
test('成功：清掉旧失败并刷新索引', async () => {
    clearSessionActionFailure();
    const calls = [];
    const ok = await requestReconnect({
        reconnect: async () => { calls.push('reconnect'); return {}; },
        refresh: async () => { calls.push('refresh'); },
    });
    assert.equal(ok, true);
    assert.deepEqual(calls, ['reconnect', 'refresh']);
    assert.equal(lastSessionActionFailure(), null);
});
test('失败：记录结构化失败并通知订阅者（不再无声吞掉）', async () => {
    clearSessionActionFailure();
    let notified = 0;
    const off = subscribeSessionActions(() => { notified += 1; });
    const ok = await requestReconnect({
        reconnect: async () => { throw Object.assign(new Error('boom'), { code: 'remote/startup-failed', detail: '远端没起来', nextActions: ['重试'] }); },
        refresh: async () => undefined,
    });
    assert.equal(ok, false);
    const failure = lastSessionActionFailure();
    assert.equal(failure?.code, 'remote/startup-failed');
    assert.equal(failure?.detail, '远端没起来', 'detail 保留宿主原文；文案交给面板字典');
    assert.ok(!JSON.stringify(failure).includes('重试'), '客户端不许自带中文文案（check:cjk）');
    assert.equal(notified, 1);
    off();
});
test('失败是粘性的：菜单关掉之后面板仍能看到（直到下一次成功或手动清除）', async () => {
    clearSessionActionFailure();
    await requestReconnect({
        reconnect: async () => { throw new Error('x'); },
        refresh: async () => undefined,
    });
    assert.notEqual(lastSessionActionFailure(), null);
    clearSessionActionFailure();
    assert.equal(lastSessionActionFailure(), null);
});
//# sourceMappingURL=session-actions.test.js.map