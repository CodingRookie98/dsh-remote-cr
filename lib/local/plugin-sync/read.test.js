import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReadScript, encodeScript, readRemoteBundles } from "./read.js";
/** L2：读远端清单的脚本形状与错误分类。数据形状来自 spikes/m3-plugin-sync 的真机样本。 */
function fakeExec(result) {
    const scripts = [];
    return {
        scripts,
        exec: async (script) => {
            scripts.push(script);
            return result;
        },
    };
}
test('脚本文本 base64 投递：躲开两层 shell 的引号', () => {
    const script = buildReadScript({ nodeCommand: '/s/bin/node', profile: 'web', homeDir: '/home/hui' });
    assert.match(script, /base64 -d > "\$f"/);
    assert.match(script, /'\/s\/bin\/node'/);
    assert.match(script, /'\/home\/hui\/\.dsh\/profiles\/web'/);
    assert.match(script, /trap 'rm -f "\$f"' EXIT/);
    // 脚本正文不能在 shell 里裸奔（含引号与括号）
    assert.ok(!script.includes('JSON.parse'));
});
test('encodeScript 是 UTF-8 base64，可往返', () => {
    const text = 'const x = 1\n';
    assert.equal(Buffer.from(encodeScript(text), 'base64').toString('utf8'), text);
});
test('读成功：映射成 RemoteBundle[]，官方项的 version 为 null 也原样保留', async () => {
    const { exec } = fakeExec({
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
            ok: true,
            root: '/home/hui/.dsh/profiles/web',
            bundles: [
                { name: '@deepseek-ai/dsh-base', version: null, error: 'ENOENT' },
                { name: 'dsh-ops', version: '0.5.5', error: null },
                { name: '', version: 'x' },
            ],
        }),
    });
    const rows = await readRemoteBundles({ exec, nodeCommand: '/s/bin/node', homeDir: '/home/hui' });
    assert.deepEqual(rows, [
        { name: '@deepseek-ai/dsh-base', version: null },
        { name: 'dsh-ops', version: '0.5.5' },
    ]);
});
test('退出码非零：remote/plugin-sync-read-failed，带 stderr 尾巴', async () => {
    const { exec } = fakeExec({ code: 2, stdout: '', stderr: 'ENOENT: profile' });
    await assert.rejects(() => readRemoteBundles({ exec, nodeCommand: '/s/bin/node' }), (error) => {
        const typed = error;
        assert.equal(typed.code, 'remote/plugin-sync-read-failed');
        assert.match(String(typed.detail), /退出码 2/);
        assert.ok((typed.nextActions ?? []).length > 0, '铁律 4：失败必须带下一步');
        return true;
    });
});
test('输出不是 JSON：同样给结构化错误，而不是把原文当清单', async () => {
    const { exec } = fakeExec({ code: 0, stdout: 'node: not found', stderr: '' });
    await assert.rejects(() => readRemoteBundles({ exec, nodeCommand: 'node' }), (error) => error.code === 'remote/plugin-sync-read-failed');
});
test('远端回 ok=false：把 reason 带进 detail', async () => {
    const { exec } = fakeExec({
        code: 0,
        stderr: '',
        stdout: JSON.stringify({ ok: false, reason: 'manifest-unreadable', detail: 'ENOENT' }),
    });
    await assert.rejects(() => readRemoteBundles({ exec, nodeCommand: 'node' }), (error) => {
        const typed = error;
        assert.equal(typed.code, 'remote/plugin-sync-read-failed');
        assert.match(String(typed.detail), /manifest-unreadable/);
        return true;
    });
});
test('默认 profile 是 web，且只允许一次 exec', async () => {
    const { exec, scripts } = fakeExec({
        code: 0,
        stderr: '',
        stdout: JSON.stringify({ ok: true, bundles: [] }),
    });
    await readRemoteBundles({ exec, nodeCommand: 'node' });
    assert.equal(scripts.length, 1, 'GET 只允许一次远端 exec（契约 §2）');
    assert.match(scripts[0] ?? '', /'web'/);
});
//# sourceMappingURL=read.test.js.map