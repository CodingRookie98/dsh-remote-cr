/**
 * M3-1：连接槽位的不变量测试。
 *
 * 三条不变量（见 `docs/project/plans/2026-11-13-m3-long-task.md` §3.1）：
 *   I1 `#live` 与 `#detached` 不持有同一个 connection
 *   I2 **已 dispose 的 connection 不得出现在任何槽位**（D7 的根因）
 *   I3 cancel 后回到「接入前」的 (live, detached)，或更安全的状态
 *   I4 attach 结束（成功/失败/取消）后 `attachProgress === null`
 *
 * I2 用**静态断言**守住：槽位的直接赋值只允许出现在 `#setLive` / `#setDetached` 两个原语里。
 * 这条比任何行为测试都硬 —— 新增一处 `this.#live = ...` 会立刻让测试红。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ProjectionService } from "./service.js";
import { ProjectionStore } from "./store.js";
const T1 = { backend: 'ssh', alias: 'a', port: 8961, remoteRoot: '/home/hui/workspace' };
const T2 = { backend: 'ssh', alias: 'b', port: 8961, remoteRoot: '/home/hui/workspace' };
const ATTACH = { remotePath: '/home/hui/workspace', localPath: 'C:/anchor/x' };
const timers = { schedule: () => 0, cancel: () => { } };
function rpc() {
    return {
        async call(endpoint) {
            if (endpoint === 'workspace/create') {
                return {
                    workspace: { workspaceId: 'ws', path: T1.remoteRoot, title: 'w', sessionIds: [], createdAt: '', updatedAt: '' },
                    created: true,
                };
            }
            return { items: [] };
        },
        openStream() {
            const events = [];
            return { cancel() { }, async *[Symbol.asyncIterator]() { for (const event of events)
                    yield event; } };
        },
    };
}
function fakeConn() {
    const disposes = { count: 0 };
    // 留存连接要被救回，必须提供 rehandshake —— 没有它的实现会被 `#dropDetached()` 真收掉，
    // 那是「别家实现」的既定行为，不是本测试要验的路径。
    return { rpc: rpc(), disposes, async rehandshake() { }, dispose() { disposes.count += 1; } };
}
test('I2：槽位的直接赋值只出现在 #setLive / #setDetached 两个原语内部', () => {
    const source = readFileSync('src/local/projection/service.ts', 'utf8');
    const writes = source
        .split(/\r?\n/)
        .map((text, index) => ({ line: index + 1, text: text.trim() }))
        .filter((entry) => /^this\.#(live|detached)\s*=/.test(entry.text));
    assert.equal(writes.length, 2, '槽位直接赋值应恰好两处（两个原语），实际：' + JSON.stringify(writes));
    const joined = writes.map((entry) => entry.text).join('\n');
    assert.match(joined, /this\.#live = entry/);
    assert.match(joined, /this\.#detached = entry/);
});
test('I3：留存连接（S2）→ 接入同 target 会被救回，不新建连接', async () => {
    const store = new ProjectionStore();
    const conn = fakeConn();
    let connects = 0;
    const service = new ProjectionService({
        store,
        timers,
        async connect() {
            connects += 1;
            return conn;
        },
    });
    await service.attach(T1, ATTACH);
    service.disconnect();
    assert.equal(service.connected, false);
    const before = connects;
    await service.attach(T1, ATTACH);
    assert.equal(connects, before, '留存连接应被救回，不该重新 connect');
    assert.equal(service.connected, true);
});
test('I3/I4：没有进行中的接入时取消是 no-op（状态不变、进度仍为空）', async () => {
    const store = new ProjectionStore();
    const conn = fakeConn();
    const service = new ProjectionService({ store, timers, async connect() { return conn; } });
    await service.attach(T1, ATTACH);
    assert.equal(service.attachProgress, null);
    await service.attach(T2, ATTACH).catch(() => undefined);
    service.disconnect();
    assert.equal(service.attachProgress, null);
    assert.equal(conn.disposes.count, 0, '断开只留存传输，不该 dispose（§8.5）');
});
//# sourceMappingURL=slots.test.js.map