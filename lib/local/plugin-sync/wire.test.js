import assert from 'node:assert/strict';
import test from 'node:test';
import { createSyncRoutesOptions } from "./wire.js";
const TARGET = { backend: 'ssh', alias: 'demo', port: 22, remoteRoot: '/home/hui/workspace' };
function wiring(overrides = {}) {
    const calls = [];
    const FAKE_TARGET = {
        alias: 'demo',
        hostName: '127.0.0.1',
        user: 'hui',
        port: 22,
        identityFiles: ['/home/hui/.ssh/id_ed25519'],
        proxyJump: [],
        source: { file: 'C:/Users/hui/.ssh/config', line: 1 },
    };
    const options = createSyncRoutesOptions({
        homeDir: 'C:/Users/hui',
        resolveTarget: () => FAKE_TARGET,
        runSsh: async (request) => {
            calls.push(request);
            return overrides.result ?? { code: 0, stdout: '{}', stderr: '', durationMs: 1 };
        },
    });
    return { options, calls };
}
test('SSH 目标：org 路径都指向本机状态根，node 用 auto（真实路径由远端回报）', () => {
    const { options } = wiring();
    assert.match(options.optoutFile.replace(/\\/g, '/'), /Users\/hui\/\.dsh-remote-cr\/sync-optout\.json$/);
    assert.match(options.localProfileDir.replace(/\\/g, '/'), /Users\/hui\/\.dsh\/profiles\/web$/);
    assert.equal(options.profile, 'web');
});
test('SSH 目标：exec 走一条 sh -c，并把脚本转义后交给远端', async () => {
    const { options, calls } = wiring({ result: { code: 0, stdout: 'ok', stderr: '' } });
    const backend = await options.resolve(TARGET);
    assert.equal(backend.nodeCommand, 'auto');
    const out = await backend.exec("echo 'hi'", 1234);
    assert.deepEqual(out, { code: 0, stdout: 'ok', stderr: '' });
    const request = calls[0];
    assert.deepEqual(request.command.slice(0, 2), ['sh', '-c']);
    assert.match(request.command[2] ?? '', /echo '\\''hi'\\''/, '脚本里的单引号必须被转义');
    assert.equal(request.deadlineMs, 1234);
    assert.equal(request.allowFailure, true);
});
test('WSL 目标：明确拒绝并给下一步（不做一个永远失败的按钮）', async () => {
    const { options } = wiring();
    await assert.rejects(() => options.resolve({ backend: 'wsl', distro: 'ubuntu_dev', port: 8899, remoteRoot: '/home/hui' }), (error) => {
        const typed = error;
        assert.equal(typed.code, 'remote/plugin-sync-unsupported');
        assert.ok((typed.nextActions ?? []).length > 0);
        return true;
    });
});
test('targetId：SSH 用 anchorIdFor(host+user+port)，WSL 用 wsl:<distro>（B5）', async () => {
    const { anchorIdFor, anchorTargetOf } = await import("../backend/ssh/anchors.js");
    const { options } = wiring();
    const expected = anchorIdFor(anchorTargetOf({
        alias: 'demo',
        hostName: '127.0.0.1',
        user: 'hui',
        port: 22,
        identityFiles: ['/home/hui/.ssh/id_ed25519'],
        proxyJump: [],
        source: { file: 'C:/Users/hui/.ssh/config', line: 1 },
    }));
    assert.equal(await options.targetId({ backend: 'ssh', alias: 'demo', port: 22, remoteRoot: '/x' }), expected);
    assert.equal(await options.targetId({ backend: 'wsl', distro: 'ubuntu_dev', port: 8899, remoteRoot: '/x' }), 'wsl:ubuntu_dev');
});
//# sourceMappingURL=wire.test.js.map