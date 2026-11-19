import assert from 'node:assert/strict';
import test from 'node:test';
import { attachKeyOf, beginAttach, decideAttach, failAttach, IDLE_ATTACH, retryAttach, settleAttach, } from "./host-attach.js";
const DEFAULTS = { port: 8899, remoteRoot: '/home/hui/.dsh-remote-cr' };
const WSL = {
    localPath: '\\\\wsl.localhost\\ubuntu_dev\\home\\hui\\proj',
    source: 'wsl',
    distro: 'ubuntu_dev',
    posixPath: '/home/hui/proj',
    unc: '\\\\wsl.localhost\\ubuntu_dev\\home\\hui\\proj',
    remote: null,
};
const LOCAL = {
    localPath: 'D:\\work\\proj',
    source: 'local',
    distro: null,
    posixPath: null,
    unc: null,
    remote: null,
};
function input(overrides = {}) {
    return { open: true, step: 'done', record: WSL, defaults: DEFAULTS, current: IDLE_ATTACH, ...overrides };
}
test('WSL 记录在 done 阶段触发一次接入，键包含记录/发行版/远端根', () => {
    const decision = decideAttach(input());
    assert.equal(decision.kind, 'start');
    assert.equal(decision.kind === 'start' ? decision.key : '', attachKeyOf(WSL, DEFAULTS));
});
test('本机目录与缺 posix/远端根都静默跳过（不在 done 屏摆红字）', () => {
    assert.deepEqual(decideAttach(input({ record: LOCAL })), { kind: 'skip', reason: 'not-wsl' });
    assert.deepEqual(decideAttach(input({ record: { ...WSL, posixPath: null } })), { kind: 'skip', reason: 'no-posix' });
    assert.deepEqual(decideAttach(input({ defaults: { port: 8899, remoteRoot: '' } })), {
        kind: 'skip',
        reason: 'no-remote-root',
    });
});
test('关窗 / 未到 done / 没有记录都不接', () => {
    assert.deepEqual(decideAttach(input({ open: false })), { kind: 'skip', reason: 'closed' });
    assert.deepEqual(decideAttach(input({ step: 'browse' })), { kind: 'skip', reason: 'not-done' });
    assert.deepEqual(decideAttach(input({ record: null })), { kind: 'skip', reason: 'no-record' });
});
test('同一条记录已经接过（running/done/failed）：effect 重跑不再起第二个远端', () => {
    const key = attachKeyOf(WSL, DEFAULTS);
    for (const current of [
        beginAttach(IDLE_ATTACH, key),
        settleAttach(beginAttach(IDLE_ATTACH, key), key),
        failAttach(beginAttach(IDLE_ATTACH, key), key, { code: 'remote/x', detail: 'x', nextActions: [] }),
    ]) {
        assert.deepEqual(decideAttach(input({ current })), { kind: 'skip', reason: 'already' });
    }
});
test('晚到的失败不覆盖另一条记录；重试保留 key 且清掉失败', () => {
    const first = beginAttach(IDLE_ATTACH, 'a');
    const moved = beginAttach(first, 'b');
    const lateFailure = failAttach(moved, 'a', { code: 'remote/x', detail: 'x', nextActions: [] });
    assert.equal(lateFailure.key, 'b', '别的记录的失败不许改当前的 key');
    assert.equal(lateFailure.phase, 'running');
    const failed = failAttach(moved, 'b', { code: 'remote/x', detail: '远端没起来', nextActions: ['重试'] });
    assert.equal(failed.phase, 'failed');
    const retried = retryAttach(failed);
    assert.equal(retried.phase, 'running');
    assert.equal(retried.key, 'b');
    assert.equal(retried.failure, null);
});
//# sourceMappingURL=host-attach.test.js.map