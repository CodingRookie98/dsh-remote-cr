import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHostInstallScript, buildRegistryProbeScript, HOST_INSTALLED_MARK, npmCommandFor, parseInstalledVersion, REGISTRY_UNAVAILABLE_MARK, upgradeRemoteHost, } from "./host-upgrade.js";
function fakeExec(results) {
    const calls = [];
    let at = 0;
    return {
        calls,
        exec: async (script, deadlineMs) => {
            calls.push({ script, deadlineMs });
            const hit = results[at] ?? results[results.length - 1];
            at += 1;
            return hit ?? { code: 0, stdout: '', stderr: '' };
        },
    };
}
const REQUEST = {
    stagingDir: '/home/hui/.dsh-remote-cr/staging/abc',
    nodeBin: '/home/hui/.dsh-remote-cr/staging/abc/bin',
    version: '0.2.2-rc.4',
    dshHome: '/home/hui/.dsh',
    registry: 'https://registry.npmjs.org/',
};
test('探测脚本：包名@确切版本、registry 与 npm 都被引起来；哨兵 $PATH 不当作目录；npm 输出要留下来', () => {
    const script = buildRegistryProbeScript({ version: '0.2.2-rc.4', nodeBin: '$PATH', registry: 'https://r/' });
    assert.match(script, /2>&1/, '不能把 npm 的报错丢进 /dev/null（404 与 EAI_AGAIN 必须能分开）');
    assert.ok(!script.includes('/dev/null'), script);
    assert.match(script, /NPM_CONFIG_REGISTRY='https:\/\/r\/' npm view '@deepseek-ai\/dsh@0\.2\.2-rc\.4' version/);
    assert.match(script, new RegExp(REGISTRY_UNAVAILABLE_MARK));
    assert.ok(!script.includes("'$PATH'/npm"), '哨兵不是路径，绝不能拼成 $PATH/npm');
    assert.equal(npmCommandFor('$PATH'), 'npm');
});
test('探测非零（npm 明确 404）→ host-version-unavailable，且**不**去装', async () => {
    const fake = fakeExec([{ code: 6, stdout: '', stderr: 'npm ERR! code E404\n' + REGISTRY_UNAVAILABLE_MARK }]);
    await assert.rejects(() => upgradeRemoteHost({ exec: fake.exec, ...REQUEST }), (error) => {
        const typed = error;
        assert.equal(typed.code, 'remote/host-version-unavailable');
        assert.match(String(typed.detail), /0\.2\.2-rc\.4/);
        assert.ok((typed.nextActions ?? []).length > 0, '铁律 4：失败必须带下一步');
        return true;
    });
    assert.equal(fake.calls.length, 1, '探测失败时不许进入安装（那会把 registry 404 说成安装失败）');
});
test('探测非零但不是 404（网络/权限）→ host-upgrade-failed，且把 npm 原文留在日志里（R1 BLK-2）', async () => {
    const fake = fakeExec([{ code: 6, stdout: '', stderr: 'npm ERR! code EAI_AGAIN\nnpm ERR! network request failed' }]);
    await assert.rejects(() => upgradeRemoteHost({ exec: fake.exec, ...REQUEST }), (error) => {
        const typed = error;
        assert.equal(typed.code, 'remote/host-upgrade-failed', '网络问题不能报成「版本不存在」');
        assert.match(String(typed.detail), /探测阶段失败/);
        assert.match(String(typed.logTail), /EAI_AGAIN/, 'npm 原文必须留下来');
        assert.ok((typed.nextActions ?? []).some((action) => action.includes('registry')));
        return true;
    });
    assert.equal(fake.calls.length, 1, '探测阶段失败就不该去装');
});
test('安装非零 → host-upgrade-failed，带退出码与可照抄命令', async () => {
    const fake = fakeExec([
        { code: 0, stdout: '', stderr: '' },
        { code: 1, stdout: '', stderr: 'EACCES: permission denied' },
    ]);
    await assert.rejects(() => upgradeRemoteHost({ exec: fake.exec, ...REQUEST }), (error) => {
        const typed = error;
        assert.equal(typed.code, 'remote/host-upgrade-failed');
        assert.match(String(typed.detail), /退出码 1/);
        assert.match(String(typed.logTail), /EACCES/);
        assert.ok((typed.nextActions ?? []).some((action) => action.includes('install --global')), '要给出可照抄的安装命令');
        return true;
    });
    assert.equal(fake.calls.length, 2);
});
test('装完版本不符 → host-upgrade-failed（不接受「命令成功」当结论）', async () => {
    const fake = fakeExec([
        { code: 0, stdout: '', stderr: '' },
        { code: 0, stdout: '0.2.1-rc.5\n' + HOST_INSTALLED_MARK + '\n', stderr: '' },
    ]);
    await assert.rejects(() => upgradeRemoteHost({ exec: fake.exec, ...REQUEST }), (error) => {
        const typed = error;
        assert.equal(typed.code, 'remote/host-upgrade-failed');
        assert.match(String(typed.detail), /0\.2\.1-rc\.5/);
        assert.match(String(typed.detail), /0\.2\.2-rc\.4/);
        return true;
    });
});
test('成功：返回远端自报的版本，安装命令含确切版本且带 staging 前缀', async () => {
    const fake = fakeExec([
        { code: 0, stdout: '0.2.2-rc.4\n', stderr: '' },
        { code: 0, stdout: '0.2.2-rc.4\n' + HOST_INSTALLED_MARK + '\n', stderr: '' },
    ]);
    const done = await upgradeRemoteHost({ exec: fake.exec, ...REQUEST });
    assert.equal(done.version, '0.2.2-rc.4');
    const install = fake.calls[1]?.script ?? '';
    assert.match(install, /install --global --no-audit --no-fund '@deepseek-ai\/dsh@0\.2\.2-rc\.4'/);
    assert.match(install, /NPM_CONFIG_PREFIX='\/home\/hui\/\.dsh-remote-cr\/staging\/abc\/npm'/);
});
test('注入面：版本里的单引号不能逃出引号', () => {
    const script = buildRegistryProbeScript({ version: "1.0.0'; touch /tmp/pwned; #", nodeBin: '/b', registry: 'https://r/' });
    assert.ok(script.includes("'@deepseek-ai/dsh@1.0.0'\\''; touch /tmp/pwned; #'"), script);
    const install = buildHostInstallScript({ ...REQUEST, version: "1.0.0'; touch /tmp/pwned; #" });
    assert.ok(install.includes("'@deepseek-ai/dsh@1.0.0'\\''; touch /tmp/pwned; #'"), install);
});
test('parseInstalledVersion：没有标记 / 只有 NOT_ON_PATH → null（没验过就是没验过）', () => {
    assert.equal(parseInstalledVersion(''), null);
    assert.equal(parseInstalledVersion(HOST_INSTALLED_MARK + '\n'), null);
    assert.equal(parseInstalledVersion('REMOTE_CR_DSH_NOT_ON_PATH\n' + HOST_INSTALLED_MARK), null);
    assert.equal(parseInstalledVersion('0.2.2-rc.4\n' + HOST_INSTALLED_MARK), '0.2.2-rc.4');
});
//# sourceMappingURL=host-upgrade.test.js.map