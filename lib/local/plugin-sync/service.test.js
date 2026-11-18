import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applySyncPlan, buildSyncPlan, resetApplyingForTest } from "./service.js";
import { readOptout, setMuted, writeOptout } from "./optout.js";
/** L1：optout 本地落盘 + L2：编排（假 exec 跑完整链路）。 */
test('optout：缺文件当空、坏 JSON 当空、写入去重排序、可增删', () => {
    const dir = mkdtempSync(join(tmpdir(), 'remote-cr-optout-'));
    const file = join(dir, 'sync-optout.json');
    try {
        assert.deepEqual(readOptout(file), []);
        writeFileSync(file, '{oops', 'utf8');
        assert.deepEqual(readOptout(file), []);
        writeOptout(file, ['b', 'a', 'a']);
        assert.deepEqual(readOptout(file), ['a', 'b']);
        assert.deepEqual(setMuted(file, 'c', true), ['a', 'b', 'c']);
        assert.deepEqual(setMuted(file, 'a', false), ['b', 'c']);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
function backend(payload, code = 0) {
    const calls = [];
    return {
        calls,
        backend: {
            nodeCommand: '/s/bin/node',
            dshCommand: '/s/npm/bin/dsh',
            nodeBin: '/s/bin',
            homeDir: '/home/hui',
            exec: async (script) => {
                calls.push(script);
                return { code, stdout: typeof payload === 'string' ? payload : JSON.stringify(payload), stderr: code === 0 ? '' : 'boom' };
            },
        },
    };
}
test('buildSyncPlan：远端空 → 第三方全部 install，官方不出现，muted 透传', async () => {
    const { backend: stub } = backend({ ok: true, bundles: [] });
    const plan = await buildSyncPlan({
        backend: stub,
        targetId: 't1',
        muted: false,
        local: [
            { name: '@deepseek-ai/dsh-base', version: null },
            { name: 'dsh-ops', version: '0.5.5' },
        ],
    });
    assert.deepEqual(plan.entries.map((entry) => entry.name), ['dsh-ops']);
    assert.deepEqual(plan.totals, { install: 1, upToDate: 0, skipped: 0 });
    assert.equal(plan.muted, false);
    assert.equal(plan.profile, 'web');
});
test('buildSyncPlan：远端已装同版本 → up-to-date（不产生 install）', async () => {
    const { backend: stub } = backend({ ok: true, bundles: [{ name: 'dsh-ops', version: '0.5.5' }] });
    const plan = await buildSyncPlan({ backend: stub, targetId: 't1', muted: true, local: [{ name: 'dsh-ops', version: '0.5.5' }] });
    assert.equal(plan.entries[0]?.action, 'up-to-date');
    assert.equal(plan.totals.install, 0);
    assert.equal(plan.muted, true);
});
test('buildSyncPlan：远端读取失败 → remote/plugin-sync-read-failed（不让空列表冒充成功）', async () => {
    const { backend: stub } = backend('', 3);
    await assert.rejects(() => buildSyncPlan({ backend: stub, targetId: 't1', muted: false, local: [] }), (error) => error.code === 'remote/plugin-sync-read-failed');
});
test('applySyncPlan：命令带 PATH 与确切版本；逐条结果回传', async () => {
    resetApplyingForTest();
    const { backend: stub, calls } = backend({ ok: true, bundles: [] });
    const results = await applySyncPlan({
        backend: stub,
        targetId: 't2',
        entries: [
            { name: 'a', action: 'install', reasonId: 'missing-remote', localVersion: '1.0.0', remoteVersion: null },
            { name: 'b', action: 'install', reasonId: 'missing-remote', localVersion: '2.0.0', remoteVersion: null },
        ],
    });
    assert.deepEqual(results.map((result) => result.ok), [true, true]);
    assert.equal(calls.length, 2);
    assert.match(calls[0] ?? '', /PATH='\/s\/bin':\$PATH/);
    assert.match(calls[0] ?? '', /'a@1\.0\.0'/);
});
test('applySyncPlan：同一 target 并发执行直接拒绝（避免 pnpm 互踩）', async () => {
    resetApplyingForTest();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const stub = {
        nodeCommand: 'node', dshCommand: 'dsh', nodeBin: '/b', homeDir: '/home/hui',
        exec: async () => { await gate; return { code: 0, stdout: '', stderr: '' }; },
    };
    const first = applySyncPlan({ backend: stub, targetId: 't3', entries: [{ name: 'a', action: 'install', reasonId: 'missing-remote', localVersion: '1.0.0', remoteVersion: null }] });
    await assert.rejects(() => applySyncPlan({ backend: stub, targetId: 't3', entries: [] }), (error) => error.code === 'remote/plugin-sync-unsupported');
    release?.();
    await first;
    resetApplyingForTest();
});
//# sourceMappingURL=service.test.js.map