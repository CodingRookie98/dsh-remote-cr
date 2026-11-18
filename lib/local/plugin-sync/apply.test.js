import assert from 'node:assert/strict';
import test from 'node:test';
import { applySync, buildInstallCommand } from "./apply.js";
function entry(name, overrides = {}) {
    return { name, action: 'install', reasonId: 'missing-remote', localVersion: '1.0.0', remoteVersion: null, ...overrides };
}
test('安装命令带 PATH 与确切版本（dsh 是 #!/usr/bin/env node，缺 PATH 会 127）', () => {
    const command = buildInstallCommand({
        dshCommand: '/home/hui/.dsh-remote-cr/staging/abc/npm/bin/dsh',
        nodeBin: '/home/hui/.dsh-remote-cr/staging/abc/bin',
        profile: 'web',
        name: 'dsh-ops',
        version: '0.5.5',
    });
    assert.match(command, /^PATH='\/home\/hui\/\.dsh-remote-cr\/staging\/abc\/bin':\$PATH /);
    assert.match(command, /'dsh-ops@0\.5\.5'$/);
    assert.match(command, /plugin --profile 'web' add /);
});
test('版本缺失：整条拒绝，不发命令', () => {
    assert.throws(() => buildInstallCommand({ dshCommand: 'dsh', nodeBin: '/b', profile: 'web', name: 'x', version: null }), (error) => error.code === 'remote/plugin-sync-unsupported');
});
test('混入非 install 项：整单拒绝（UI 漏判不许写坏远端）', async () => {
    const calls = [];
    await assert.rejects(() => applySync({
        entries: [entry('a'), entry('b', { action: 'up-to-date', reasonId: 'none' })],
        dshCommand: 'dsh',
        nodeBin: '/b',
        exec: async (script) => {
            calls.push(script);
            return { code: 0, stdout: '', stderr: '' };
        },
    }), (error) => error.code === 'remote/plugin-sync-unsupported');
    assert.equal(calls.length, 0, '拒绝时不许执行任何命令');
});
test('逐条独立：一条失败不影响后续，结果逐条回传', async () => {
    const seen = [];
    const results = await applySync({
        entries: [entry('a'), entry('b'), entry('c')],
        dshCommand: 'dsh',
        nodeBin: '/b',
        exec: async (script) => {
            seen.push(script);
            return script.includes("'b@") ? { code: 1, stdout: '', stderr: 'E404 not found' } : { code: 0, stdout: 'ok', stderr: '' };
        },
        onResult: (result) => seen.push('progress:' + result.name + ':' + String(result.ok)),
    });
    assert.deepEqual(results.map((result) => [result.name, result.ok]), [['a', true], ['b', false], ['c', true]]);
    assert.equal(results[1]?.code, 'remote/plugin-sync-apply-failed');
    assert.match(String(results[1]?.detail), /E404/);
    assert.deepEqual(seen.filter((item) => item.startsWith('progress:')), ['progress:a:true', 'progress:b:false', 'progress:c:true']);
});
test('空列表：返回空数组，不执行任何命令', async () => {
    const calls = [];
    const results = await applySync({ entries: [], dshCommand: 'dsh', nodeBin: '/b', exec: async (s) => { calls.push(s); return { code: 0, stdout: '', stderr: '' }; } });
    assert.deepEqual(results, []);
    assert.equal(calls.length, 0);
});
test('检出形态（WSL）：node <bin.js> 且仍带 PATH= 前缀（变异点 M2：去掉 PATH= 必红）', () => {
    const command = buildInstallCommand({
        dshCommand: '/home/hui/workspace/tools/deepseek-harness/apps/cli/lib/bin.js',
        nodeBin: '/usr/bin',
        interpreter: '/usr/bin/node',
        profile: 'web',
        name: 'dsh-ops',
        version: '0.5.5',
    });
    assert.match(command, /^PATH='\/usr\/bin':\$PATH '/);
    assert.ok(command.includes("'/usr/bin/node' '/home/hui/workspace/tools/deepseek-harness/apps/cli/lib/bin.js' plugin"), command);
    assert.match(command, /'dsh-ops@0\.5\.5'$/);
});
test('不知道 nodeBin 时不拼 PATH（空前缀会把当前目录塞进搜索路径）', () => {
    const command = buildInstallCommand({
        dshCommand: '/home/hui/workspace/tools/deepseek-harness/apps/cli/lib/bin.js',
        nodeBin: '',
        profile: 'web',
        name: 'dsh-ops',
        version: '0.5.5',
    });
    assert.ok(!command.includes('PATH='), command);
    assert.ok(command.startsWith("'/home/hui/workspace/tools/deepseek-harness/apps/cli/lib/bin.js' plugin"), command);
});
test('applySync 把解释器透传到每一条命令（不用调用方自己拼）', async () => {
    const seen = [];
    await applySync({
        entries: [entry('a')],
        dshCommand: '/w/bin.js',
        nodeBin: '/usr/bin',
        interpreter: '/usr/bin/node',
        exec: async (script) => {
            seen.push(script);
            return { code: 0, stdout: '', stderr: '' };
        },
    });
    assert.equal(seen.length, 1);
    assert.ok(String(seen[0]).includes("'/usr/bin/node' '/w/bin.js'"), String(seen[0]));
});
test('注入面：包名/版本里的单引号与分号必须被转义，不能逃出引号（B6）', () => {
    const name = "evil'; touch /tmp/pwned; #";
    const version = "1.0.0'; touch /tmp/pwned2; #";
    const command = buildInstallCommand({ dshCommand: '/s/npm/bin/dsh', nodeBin: '/s/bin', profile: 'web', name, version });
    // 期望：整段被 shellQuote 包住，内部单引号变成 '\'' —— 原样拼进去的 ; 只可能在引号内
    assert.ok(command.includes("'evil'\\''; touch /tmp/pwned; #@1.0.0'\\''; touch /tmp/pwned2; #'"), command);
    // 反证：把转义去掉的实现会让下面的断言失败（变异 M8 现在必须红）
    const naive = "'" + name + '@' + version + "'";
    assert.notEqual(command, command.replace("'evil'\\''", "'evil'"), '命令里必须出现转义序列');
    assert.notEqual(naive, command);
});
//# sourceMappingURL=apply.test.js.map