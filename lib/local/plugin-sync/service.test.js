import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { syncBlockedReason } from "../../client/sync-state.js";
import { acquireWrite, releaseWrite } from "./locks.js";
import { applySyncPlan, buildSyncPlan, resetApplyingForTest } from "./service.js";
import { readOptout, setMuted, writeOptout } from "./optout.js";
/** L1：optout 本地落盘 + L2：编排（假 exec 跑完整链路）。 */
test('optout：写入是原子的（不留 .tmp、读到的永远是完整 JSON）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'remote-cr-optout-atomic-'));
    const file = join(dir, 'sync-optout.json');
    try {
        setMuted(file, 'a', true);
        setMuted(file, 'b', true);
        assert.deepEqual(readdirSync(dir).sort(), ['sync-optout.json'], 'rename 之后不许留临时文件');
        assert.deepEqual(readOptout(file), ['a', 'b']);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
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
    // 判据要下发给客户端，否则 UI 只能用「runtime 为空」拦人（SSH 的 PATH 形态会被误拦）。
    assert.equal(plan.requiresRuntime, false, '没声明的后端按 false');
    const wsl = await buildSyncPlan({ backend: { ...stub, requiresRuntime: true }, targetId: 'wsl:ubuntu_dev', muted: false, local: [] });
    assert.equal(wsl.requiresRuntime, true);
    // 贯通：服务端下发的字段真的能让客户端的判据生效（两侧各自断言正确，不等于缝对上了）。
    assert.equal(syncBlockedReason({ ...wsl, runtime: null }), 'no-runtime');
    assert.equal(syncBlockedReason({ ...plan, runtime: null }), null, 'SSH 的 PATH 形态不该被拦');
});
test('buildSyncPlan：远端已装同版本 → up-to-date（不产生 install）', async () => {
    const { backend: stub } = backend({ ok: true, bundles: [{ name: 'dsh-ops', version: '0.5.5' }] });
    const plan = await buildSyncPlan({ backend: stub, targetId: 't1', muted: true, local: [{ name: 'dsh-ops', version: '0.5.5' }] });
    assert.equal(plan.entries[0]?.action, 'up-to-date');
    assert.equal(plan.totals.install, 0);
    assert.equal(plan.muted, true);
});
test('applySyncPlan：宿主升级占着锁时拒绝，执行 0 次且说清在等谁（R1-B1）', async () => {
    resetApplyingForTest();
    const calls = [];
    const { backend: stub } = backend({ ok: true, bundles: [] });
    const busy = { ...stub, exec: async (script) => { calls.push(script); return { code: 0, stdout: '', stderr: '' }; } };
    acquireWrite('t-shared', 'host');
    try {
        await assert.rejects(() => applySyncPlan({ backend: busy, targetId: 't-shared', entries: [{ name: 'dsh-ops', action: 'install', reasonId: 'missing-remote', localVersion: '0.5.5', remoteVersion: null }] }), (error) => {
            const typed = error;
            assert.equal(typed.code, 'remote/plugin-sync-busy', '忙要用独立的码：unsupported 会被字典渲染成「请求里包含不可同步的插件」');
            assert.match(String(typed.detail), /正在升级宿主/, '要说清在等谁，不能只说「忙」');
            return true;
        });
    }
    finally {
        releaseWrite('t-shared');
    }
    assert.equal(calls.length, 0, '拿不到锁时不许执行任何命令');
    resetApplyingForTest();
});
test('applySyncPlan：requiresRuntime 且没有 runtime → 结构化拒绝，执行 0 次（不拼必然 ENOENT 的命令）', async () => {
    resetApplyingForTest();
    const calls = [];
    const stub = {
        nodeCommand: 'auto',
        dshCommand: '/w/dsh/apps/cli/lib/bin.js',
        nodeBin: '',
        interpreter: null,
        homeDir: '',
        requiresRuntime: true,
        exec: async (script) => {
            calls.push(script);
            return { code: 0, stdout: '', stderr: '' };
        },
    };
    await assert.rejects(() => applySyncPlan({ backend: stub, runtime: null, targetId: 'wsl:ubuntu_dev', entries: [{ name: 'dsh-ops', action: 'install', reasonId: 'missing-remote', localVersion: '0.5.5', remoteVersion: null }] }), (error) => {
        const typed = error;
        assert.equal(typed.code, 'remote/plugin-sync-read-failed');
        assert.ok((typed.nextActions ?? []).length > 0, '铁律 4：失败必须带下一步');
        return true;
    });
    assert.equal(calls.length, 0, '拒绝时不许执行任何命令（否则用户会照抄一条跑不通的命令）');
    // 负控：给了 runtime 就必须照常执行（别把门禁写成永远拒绝）
    const results = await applySyncPlan({
        backend: stub,
        runtime: { homeDir: '/home/hui', nodeCommand: '/usr/bin/node', nodeBin: '/usr/bin', dshCommand: '/w/dsh/apps/cli/lib/bin.js', interpreter: '/usr/bin/node', dshRoot: '/w/dsh', source: 'checkout' },
        targetId: 'wsl:ubuntu_dev',
        entries: [{ name: 'dsh-ops', action: 'install', reasonId: 'missing-remote', localVersion: '0.5.5', remoteVersion: null }],
    });
    assert.deepEqual(results.map((result) => result.ok), [true]);
    assert.equal(calls.length, 1);
});
test('buildSyncPlan：带出宿主版本判定（staging 可升级 / checkout 拒绝）', async () => {
    const staging = {
        ok: true,
        bundles: [],
        dshVersion: '0.2.1-rc.5',
        runtime: { homeDir: '/home/hui', nodeCommand: '/usr/bin/node', nodeBin: '/usr/bin', dshCommand: '/s/npm/bin/dsh', interpreter: null, dshRoot: '/s', source: 'staging' },
    };
    const { backend: stub } = backend(staging);
    const plan = await buildSyncPlan({
        backend: { ...stub, hostVersion: '0.2.2-rc.4', supported: (v) => v.startsWith('0.2.') },
        targetId: 't1',
        muted: false,
        local: [],
    });
    assert.equal(plan.host.action, 'align');
    assert.equal(plan.host.localVersion, '0.2.2-rc.4');
    assert.equal(plan.host.remoteVersion, '0.2.1-rc.5');
    assert.equal(plan.host.source, 'staging');
    const checkout = { ...staging, runtime: { ...staging.runtime, source: 'checkout', interpreter: '/usr/bin/node', dshCommand: '/w/apps/cli/lib/bin.js' } };
    const other = await buildSyncPlan({
        backend: { ...backend(checkout).backend, hostVersion: '0.2.2-rc.4', supported: () => true },
        targetId: 't2', muted: false, local: [],
    });
    assert.equal(other.host.action, 'reject');
    assert.equal(other.host.reasonId, 'checkout-mode');
});
test('buildSyncPlan：注入的 supported 真的被用来判区间（否则 out-of-range 静默失效）', async () => {
    const payload = {
        ok: true,
        bundles: [],
        dshVersion: '0.2.1-rc.5',
        runtime: { homeDir: '/home/hui', nodeCommand: '/usr/bin/node', nodeBin: '/usr/bin', dshCommand: '/s/npm/bin/dsh', interpreter: null, dshRoot: '/s', source: 'staging' },
    };
    const { backend: stub } = backend(payload);
    const rejected = await buildSyncPlan({
        backend: { ...stub, hostVersion: '0.9.9', supported: () => false },
        targetId: 't1', muted: false, local: [],
    });
    assert.equal(rejected.host.action, 'reject');
    assert.equal(rejected.host.reasonId, 'out-of-range', '区间判定必须来自注入的 supported，不能被默认值吞掉');
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
    await assert.rejects(() => applySyncPlan({ backend: stub, targetId: 't3', entries: [] }), (error) => error.code === 'remote/plugin-sync-busy');
    release?.();
    await first;
    resetApplyingForTest();
});
//# sourceMappingURL=service.test.js.map