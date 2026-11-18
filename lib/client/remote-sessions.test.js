import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteSessionIndex } from "./remote-sessions.js";
function snapshot(sessions, workspaces = []) {
    return {
        connected: true,
        link: 'connected',
        envPolicy: 'reuse',
        target: null,
        attach: null,
        defaults: { port: 8899, remoteRoot: '/home/dev/harness' },
        workspaces: workspaces.map((id) => ({ id, title: id, localPath: '/x', remotePath: '/x', backend: 'wsl', distro: 'd', availability: 'online' })),
        sessions: sessions.map((id) => ({ sessionId: id, workspaceId: 'w', title: id, running: false, updatedAt: '2026-01-01T00:00:00Z', availability: 'online' })),
    };
}
test('索引：刷新后能查到远端会话，订阅者被通知一次', async () => {
    let calls = 0;
    const index = createRemoteSessionIndex(async () => {
        calls += 1;
        return snapshot(['s1', 's2'], ['w1']);
    });
    let notified = 0;
    const off = index.subscribe(() => { notified += 1; });
    await index.refresh();
    assert.equal(calls, 1);
    assert.equal(notified, 1);
    assert.equal(index.has('s1'), true);
    assert.equal(index.has('nope'), false);
    assert.equal(index.hasWorkspace('w1'), true);
    assert.equal(index.size, 2);
    off();
});
test('刷新失败保留上一次快照（网络抖动不该让徽标集体消失）', async () => {
    let fail = false;
    const index = createRemoteSessionIndex(async () => {
        if (fail)
            throw new Error('offline');
        return snapshot(['s1']);
    });
    await index.refresh();
    assert.equal(index.has('s1'), true);
    fail = true;
    await index.refresh();
    assert.equal(index.has('s1'), true, '失败后仍认得上一次的记忆');
});
test('并发刷新只打一次请求（面板与会话行同时挂载时）', async () => {
    let calls = 0;
    const index = createRemoteSessionIndex(async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return snapshot(['s1']);
    });
    await Promise.all([index.refresh(), index.refresh(), index.refresh()]);
    assert.equal(calls, 1);
});
//# sourceMappingURL=remote-sessions.test.js.map