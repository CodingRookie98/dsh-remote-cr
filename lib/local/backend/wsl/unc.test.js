import assert from 'node:assert/strict';
import test from 'node:test';
import { UNC_PREFIXES, fromUnc, toUnc, uncCandidates } from "./unc.js";
test('两种候选前缀按优先级排列：wsl.localhost 在前、wsl$ 在后', () => {
    assert.deepEqual([...UNC_PREFIXES], ['\\\\wsl.localhost\\', '\\\\wsl$\\']);
});
test('toUnc 把 distro 内绝对路径转成 Windows UNC', () => {
    assert.equal(toUnc('ubuntu_dev', '/home/hui'), '\\\\wsl.localhost\\ubuntu_dev\\home\\hui');
    assert.equal(toUnc('ubuntu_dev', '/home/hui/', 1), '\\\\wsl$\\ubuntu_dev\\home\\hui');
});
test('根路径不产生尾部反斜杠（带尾斜杠的 stat 在某些 Windows 版本上语义不同）', () => {
    assert.equal(toUnc('ubuntu_dev', '/'), '\\\\wsl.localhost\\ubuntu_dev');
});
test('路径里的重复斜杠归一，不会拼出 //', () => {
    assert.equal(toUnc('ubuntu_dev', '//home///hui//'), '\\\\wsl.localhost\\ubuntu_dev\\home\\hui');
});
test('uncCandidates 同时给出两种前缀，供「依次 stat、第一个成功即采用」', () => {
    assert.deepEqual(uncCandidates('ubuntu_dev', '/home/hui/w'), [
        '\\\\wsl.localhost\\ubuntu_dev\\home\\hui\\w',
        '\\\\wsl$\\ubuntu_dev\\home\\hui\\w',
    ]);
});
test('fromUnc 反向还原 distro 与 POSIX 路径（含根路径）', () => {
    assert.deepEqual(fromUnc('\\\\wsl.localhost\\ubuntu_dev\\home\\hui'), {
        distro: 'ubuntu_dev',
        posixPath: '/home/hui',
    });
    assert.deepEqual(fromUnc('\\\\wsl$\\ubuntu_dev'), { distro: 'ubuntu_dev', posixPath: '/' });
});
test('fromUnc 对非 UNC 输入返回 undefined，不猜', () => {
    assert.equal(fromUnc('C:\\Users\\hui'), undefined);
    assert.equal(fromUnc('\\\\wsl.localhost\\'), undefined);
});
test('NEGATIVE_CONTROL 可假性：把 UNC 前缀改成只有 wsl$ 一种必须让「wsl.localhost 优先」断言失败', () => {
    const onlyLegacy = ['\\\\wsl$\\'];
    if (process.env.NEGATIVE_CONTROL === '1') {
        assert.deepEqual([...UNC_PREFIXES], onlyLegacy);
        return;
    }
    assert.notDeepEqual([...UNC_PREFIXES], onlyLegacy);
});
//# sourceMappingURL=unc.test.js.map