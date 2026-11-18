import assert from 'node:assert/strict';
import test from 'node:test';
import { decideHostSync } from "./plugin-sync.js";
/** L1：宿主版本判定（H 系列）。六种输入各一条，顺序即优先级。 */
const supported = (version) => version.startsWith('0.2.');
const BASE = { supported, remoteVersion: '0.2.1-rc.5', localVersion: '0.2.2-rc.4', source: 'staging' };
test('远端是检出 → reject/checkout-mode（换版本等于换检出）', () => {
    const plan = decideHostSync({ ...BASE, source: 'checkout' });
    assert.equal(plan.action, 'reject');
    assert.equal(plan.reasonId, 'checkout-mode');
});
test('来源读不出（runtime 为 null）→ reject/source-unknown（不是「检出」，那是假话）', () => {
    const plan = decideHostSync({ ...BASE, source: null });
    assert.equal(plan.action, 'reject');
    assert.equal(plan.reasonId, 'source-unknown');
});
test('本地版本读不出 → reject/local-version-unknown（不猜）', () => {
    assert.equal(decideHostSync({ ...BASE, localVersion: null }).reasonId, 'local-version-unknown');
    assert.equal(decideHostSync({ ...BASE, localVersion: '' }).reasonId, 'local-version-unknown');
});
test('本地版本越界 → reject/out-of-range（不拿自己都不支持的版本去装）', () => {
    const plan = decideHostSync({ ...BASE, localVersion: '0.3.0-rc.1', supported });
    assert.equal(plan.action, 'reject');
    assert.equal(plan.reasonId, 'out-of-range');
});
test('远端版本读不出 → reject/remote-version-unknown（未知 ≠ 不一致）', () => {
    assert.equal(decideHostSync({ ...BASE, remoteVersion: null }).reasonId, 'remote-version-unknown');
});
test('同版本 → up-to-date；不同 → align', () => {
    assert.equal(decideHostSync({ ...BASE, remoteVersion: '0.2.2-rc.4' }).action, 'up-to-date');
    const plan = decideHostSync(BASE);
    assert.equal(plan.action, 'align');
    assert.equal(plan.reasonId, 'none');
});
//# sourceMappingURL=plugin-sync-host.test.js.map