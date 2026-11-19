import assert from 'node:assert/strict';
import test from 'node:test';
import { ProjectionHub, targetKeyOf } from "./hub.js";
import { ProjectionService } from "./service.js";
import { ProjectionStore } from "./store.js";
const A = { backend: 'ssh', alias: 'a', port: 8941, remoteRoot: '/home/hui/a' };
const B = { backend: 'ssh', alias: 'b', port: 8942, remoteRoot: '/home/hui/b' };
/** 一台会报出自己 workspaceId 的假远端：用来区分「两个引擎是不是各存各的」。 */
function fakeConnect(workspaceId) {
    return async () => ({
        rpc: {
            async call(endpoint) {
                if (endpoint === 'workspace/create') {
                    return {
                        workspace: { workspaceId, path: '/home/hui/x', title: 'x', sessionIds: [], createdAt: '', updatedAt: '' },
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
        },
        dispose() { }
    });
}
function hubWith(ids) {
    return new ProjectionHub(() => {
        const store = new ProjectionStore();
        let counter = 0;
        return new ProjectionService({
            store,
            connect: async (target) => {
                counter += 1;
                const key = target.backend === 'ssh' ? target.alias : target.distro;
                const connect = fakeConnect(ids[key] ?? 'ws-' + String(counter));
                return await connect();
            },
        });
    });
}
test('两个 target 各得一个引擎，投影互不覆盖（R1）', async () => {
    const hub = hubWith({ a: 'ws-a', b: 'ws-b' });
    await hub.attach(A, { remotePath: '/home/hui/a', localPath: 'C:/anchors/a' });
    await hub.attach(B, { remotePath: '/home/hui/b', localPath: 'C:/anchors/b' });
    assert.equal(hub.size, 2);
    assert.deepEqual(hub.snapshotOf(A)?.workspaces.map((w) => w.id), ['ws-a']);
    assert.deepEqual(hub.snapshotOf(B)?.workspaces.map((w) => w.id), ['ws-b']);
    assert.equal(hub.focused()?.snapshot().workspaces[0]?.id, 'ws-b', 'focus = 最近 attach 的那台');
});
test('同一 target 复用同一个引擎实例（R2）', async () => {
    const hub = hubWith({ a: 'ws-a' });
    const first = hub.serviceFor(A);
    await hub.attach(A, { remotePath: '/home/hui/a', localPath: 'C:/anchors/a' });
    await hub.attach(A, { remotePath: '/home/hui/a', localPath: 'C:/anchors/a' });
    assert.equal(hub.size, 1);
    assert.equal(hub.peek(A), first, '第二次 attach 必须还是同一个实例');
    assert.equal(hub.snapshotOf(A)?.workspaces.length, 1, '两次 attach 不该多出一条工作区');
});
test('peek 不建引擎：从没接过的 target 返回 undefined（A1 的「只查不建」）', () => {
    const hub = hubWith({});
    assert.equal(hub.peek(A), undefined);
    assert.equal(hub.size, 0);
    assert.deepEqual(hub.entries(), []);
});
test('disposeAll 级联且幂等（R5）', async () => {
    const hub = hubWith({ a: 'ws-a', b: 'ws-b' });
    await hub.attach(A, { remotePath: '/home/hui/a', localPath: 'C:/anchors/a' });
    await hub.attach(B, { remotePath: '/home/hui/b', localPath: 'C:/anchors/b' });
    hub.disposeAll();
    assert.equal(hub.size, 0);
    assert.equal(hub.focused(), null);
    hub.disposeAll();
});
test('targetKeyOf 与 sameTarget 同形：端口/检出根不同就是不同键', () => {
    assert.equal(targetKeyOf(A), targetKeyOf({ ...A }));
    assert.notEqual(targetKeyOf(A), targetKeyOf({ ...A, port: 9999 }));
    assert.notEqual(targetKeyOf(A), targetKeyOf({ ...A, remoteRoot: '/home/hui/other' }));
});
//# sourceMappingURL=hub.test.js.map