import assert from 'node:assert/strict';
import test from 'node:test';
import { acquireWrite, releaseWrite, resetWritesForTest, writeHolder } from "./locks.js";
/** L1：同一 target 的写路径互斥（R1-B1）。 */
test('同 target 第二种写路径拿不到锁，并说清是谁拿着', () => {
    resetWritesForTest();
    assert.deepEqual(acquireWrite('wsl:ubuntu', 'host'), { ok: true });
    assert.deepEqual(acquireWrite('wsl:ubuntu', 'apply'), { ok: false, holder: 'host' });
    assert.deepEqual(acquireWrite('wsl:ubuntu', 'host'), { ok: false, holder: 'host' });
    releaseWrite('wsl:ubuntu');
    assert.deepEqual(acquireWrite('wsl:ubuntu', 'apply'), { ok: true }, '释放后另一条写路径可用');
    resetWritesForTest();
});
test('不同 target 互不影响（锁的粒度是目标，不是全局）', () => {
    resetWritesForTest();
    assert.deepEqual(acquireWrite('a', 'host'), { ok: true });
    assert.deepEqual(acquireWrite('b', 'apply'), { ok: true });
    assert.equal(writeHolder('a'), 'host');
    assert.equal(writeHolder('b'), 'apply');
    resetWritesForTest();
    assert.equal(writeHolder('a'), null);
});
//# sourceMappingURL=locks.test.js.map