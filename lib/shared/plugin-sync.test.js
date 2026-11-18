import assert from 'node:assert/strict';
import test from 'node:test';
import { comparePluginVersions, diffBundles, planTotals } from "./plugin-sync.js";
/**
 * L1：纯函数六态（RFC-0003 契约 §6）。
 * 这些用例的形状来自真机样本：本地 15 bundle / 远端 2 个官方 —— 官方项必须**消失**，
 * 否则 UI 会误报「远端缺 9 个官方插件」。
 */
test('远端为空：第三方全部 install，官方项不出现', () => {
    const entries = diffBundles({
        local: [
            { name: '@deepseek-ai/dsh-base', version: null },
            { name: 'dsh-ops', version: '0.5.5' },
            { name: 'dshmarket', version: '1.73.20' },
        ],
        remote: [{ name: '@deepseek-ai/dsh-base', version: null }],
    });
    assert.deepEqual(entries.map((entry) => entry.name), ['dsh-ops', 'dshmarket']);
    assert.ok(entries.every((entry) => entry.action === 'install' && entry.reasonId === 'missing-remote'));
    assert.deepEqual(planTotals(entries), { install: 2, upToDate: 0, skipped: 0 });
});
test('远端更旧：install（升级到本机版本）', () => {
    const entries = diffBundles({
        local: [{ name: 'dsh-ops', version: '0.5.5' }],
        remote: [{ name: 'dsh-ops', version: '0.5.0' }],
    });
    assert.equal(entries[0]?.action, 'install');
    assert.equal(entries[0]?.reasonId, 'remote-older');
});
test('同版本：up-to-date', () => {
    const entries = diffBundles({
        local: [{ name: 'dshmarket', version: '1.73.20' }],
        remote: [{ name: 'dshmarket', version: '1.73.20' }],
    });
    assert.equal(entries[0]?.action, 'up-to-date');
    assert.equal(entries[0]?.reasonId, 'none');
});
test('远端更新：remote-newer（不降级）', () => {
    const entries = diffBundles({
        local: [{ name: 'dsh-ops', version: '0.5.5' }],
        remote: [{ name: 'dsh-ops', version: '0.6.0' }],
    });
    assert.equal(entries[0]?.action, 'remote-newer');
});
test('本地路径插件：skip-path，不进可同步集合', () => {
    const entries = diffBundles({
        local: [{ name: 'my-plugin', version: '0.1.0', specKind: 'path' }],
        remote: [],
    });
    assert.equal(entries[0]?.action, 'skip-path');
    assert.equal(entries[0]?.reasonId, 'local-path-plugin');
    assert.deepEqual(planTotals(entries), { install: 0, upToDate: 0, skipped: 1 });
});
test('本地版本未知：blocked（不猜、不装）', () => {
    const entries = diffBundles({
        local: [{ name: 'ghost', version: null }],
        remote: [{ name: 'ghost', version: '1.0.0' }],
    });
    assert.equal(entries[0]?.action, 'blocked');
    assert.equal(entries[0]?.reasonId, 'local-version-unknown');
});
test('排序稳定：install → up-to-date → remote-newer → skip-path → blocked，组内按名字', () => {
    const entries = diffBundles({
        local: [
            { name: 'z-blocked', version: null },
            { name: 'z-skip', version: '1.0.0', specKind: 'path' },
            { name: 'b-install', version: '1.0.0' },
            { name: 'a-install', version: '1.0.0' },
            { name: 'same', version: '1.0.0' },
            { name: 'newer', version: '1.0.0' },
        ],
        remote: [
            { name: 'same', version: '1.0.0' },
            { name: 'newer', version: '2.0.0' },
        ],
    });
    assert.deepEqual(entries.map((entry) => entry.name), ['a-install', 'b-install', 'same', 'newer', 'z-skip', 'z-blocked']);
});
test('版本比较：只看符号（负数=更旧，0=相同），解析不了给 null', () => {
    assert.ok((comparePluginVersions('0.2.1-rc.5', '0.2.1') ?? 0) < 0, '预发布 < 正式版');
    assert.ok((comparePluginVersions('0.2.1', '0.2.1-rc.5') ?? 0) > 0);
    assert.ok((comparePluginVersions('0.2.1-rc.2', '0.2.1-rc.10') ?? 0) < 0, 'rc.2 < rc.10（按数字比，不是字典序）');
    assert.ok((comparePluginVersions('0.2.2-rc.4', '0.2.1-rc.5') ?? 0) > 0);
    assert.equal(comparePluginVersions('1.2.3', '1.2.3'), 0);
    assert.equal(comparePluginVersions('not-a-version', '1.0.0'), null);
});
//# sourceMappingURL=plugin-sync.test.js.map