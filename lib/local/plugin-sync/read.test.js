import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { READER_SOURCE, buildReadScript, encodeScript, readRemoteBundles, readRemoteProfile } from "./read.js";
/** L2：读远端清单的脚本形状与错误分类。数据形状来自 spikes/m3-plugin-sync 的真机样本。 */
/**
 * 把 `READER_SOURCE` 在假环境里**真跑一次**，返回它打出来的 payload。
 *
 * 只断言字符串形状挡不住「整行删掉」这种变异（审查 B3 的存活变异），所以这里给假 fs/os/process
 * 直接执行正文：`require('fs')` 归我们控制，`os.homedir()` 固定，`process.argv` 由用例指定。
 */
function runReader(input) {
    const lines = [];
    const enoent = () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const fakeFs = {
        readFileSync: (file) => input.read(file) === '' ? enoent() : input.read(file),
        existsSync: (file) => input.exists(file),
        readdirSync: () => enoent(),
    };
    const sandbox = {
        require: (name) => name === 'fs' ? fakeFs
            // 远端是 Linux：这里必须用 posix 语义。Windows 的 path.join 会产出反斜杠，
            // 与被测脚本在 distro 里看到的路径不是一回事。
            : name === 'path' ? { join: path.posix.join, dirname: path.posix.dirname }
                : name === 'os' ? { homedir: () => '/home/hui' }
                    : (() => { throw new Error('reader 不该 require ' + name); })(),
        process: { argv: input.argv, execPath: '/usr/bin/node', exit: () => undefined },
        console: { log: (line) => lines.push(line) },
    };
    vm.runInNewContext(READER_SOURCE, sandbox);
    return JSON.parse(lines[lines.length - 1] ?? '{}');
}
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
test('远端脚本正文是合法 JS：拼错括号/引号必须在单测就红（真机前）', () => {
    assert.doesNotThrow(() => new vm.Script(READER_SOURCE));
    // 反证：多一个右括号必须让上面这条红（2026-11-18 真机撞过一次 Unexpected token '}'）。
    assert.throws(() => new vm.Script(READER_SOURCE + '}'));
});
test('真有检出时脚本报告检出形态（执行级：把 reader 正文真跑一遍）', () => {
    // 为什么必须执行而不能只看字符串：`interpreter` 那一行被整行删掉时，字符串断言照样绿
    // （2026-11-18 审查 B3 的存活变异）。这里用假 fs 把 READER_SOURCE 真跑一次，看它报什么。
    const files = new Set(['/w/dsh/apps/cli/lib/bin.js', '/home/hui/.dsh/profiles/web/package.json']);
    const payload = runReader({
        argv: ['node', 'reader.cjs', '', 'web', '/w/dsh'],
        exists: (path) => files.has(path),
        read: (path) => (path.endsWith('package.json') ? JSON.stringify({ dsh: { profile: { bundles: [] } } }) : ''),
    });
    assert.equal(payload.runtime?.dshCommand, '/w/dsh/apps/cli/lib/bin.js');
    assert.equal(payload.runtime?.interpreter, '/usr/bin/node', '检出里的 bin.js 要靠 node 跑（不一定带 +x）');
    assert.equal(payload.runtime?.nodeBin, '/usr/bin');
    assert.equal(payload.runtime?.dshRoot, '/w/dsh');
    // 负控：检出根里没有 apps/cli/lib/bin.js → 不给 runtime（上层据此拒绝执行，不拼必然 ENOENT 的命令）
    const missing = runReader({ argv: ['node', 'reader.cjs', '', 'web', '/w/nope'], exists: () => false, read: () => '{}' });
    assert.equal(missing.runtime, null);
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
test('同一次读取里探明远端运行时：五个字段齐才收下，缺一就当 null（不猜路径）', async () => {
    const runtime = {
        homeDir: '/home/hui',
        nodeCommand: '/home/hui/.dsh-remote-cr/staging/abc/bin/node',
        nodeBin: '/home/hui/.dsh-remote-cr/staging/abc/bin',
        dshCommand: '/home/hui/.dsh-remote-cr/staging/abc/npm/bin/dsh',
        interpreter: null,
        dshRoot: '/home/hui/.dsh-remote-cr/staging/abc',
    };
    const ok = fakeExec({ code: 0, stderr: '', stdout: JSON.stringify({ ok: true, bundles: [], runtime }) });
    const profile = await readRemoteProfile({ exec: ok.exec, nodeCommand: 'node' });
    assert.deepEqual(profile.runtime, runtime);
    const broken = fakeExec({ code: 0, stderr: '', stdout: JSON.stringify({ ok: true, bundles: [], runtime: { homeDir: '/home/hui' } }) });
    const partial = await readRemoteProfile({ exec: broken.exec, nodeCommand: 'node' });
    assert.equal(partial.runtime, null, '缺字段时整体当 null，交给 UI 提示「先接入一次」');
    const absent = fakeExec({ code: 0, stderr: '', stdout: JSON.stringify({ ok: true, bundles: [] }) });
    assert.equal((await readRemoteProfile({ exec: absent.exec, nodeCommand: 'node' })).runtime, null);
});
test('检出形态（WSL）：interpreter 原样收下，dshRoot 是检出根；interpreter 非法则整体 null', async () => {
    const runtime = {
        homeDir: '/home/hui',
        nodeCommand: '/usr/bin/node',
        nodeBin: '/usr/bin',
        dshCommand: '/home/hui/workspace/tools/deepseek-harness/apps/cli/lib/bin.js',
        interpreter: '/usr/bin/node',
        dshRoot: '/home/hui/workspace/tools/deepseek-harness',
    };
    const ok = fakeExec({ code: 0, stderr: '', stdout: JSON.stringify({ ok: true, bundles: [], runtime }) });
    assert.deepEqual((await readRemoteProfile({ exec: ok.exec, nodeCommand: 'auto' })).runtime, runtime);
    // 老脚本不带 interpreter → 按 staging 形态收下（null），不算缺字段。
    const legacy = fakeExec({
        code: 0,
        stderr: '',
        stdout: JSON.stringify({ ok: true, bundles: [], runtime: { ...runtime, interpreter: undefined } }),
    });
    const parsedLegacy = await readRemoteProfile({ exec: legacy.exec, nodeCommand: 'auto' });
    assert.equal(parsedLegacy.runtime?.interpreter, null);
    // 报了但报成空串：不可信 → 整体 null（不猜「大概是 node」）。
    const bad = fakeExec({ code: 0, stderr: '', stdout: JSON.stringify({ ok: true, bundles: [], runtime: { ...runtime, interpreter: '' } }) });
    assert.equal((await readRemoteProfile({ exec: bad.exec, nodeCommand: 'auto' })).runtime, null);
});
test('checkoutRoot：作为第 4 个参数传进脚本，且被 shellQuote（注入面）', () => {
    const plain = buildReadScript({ nodeCommand: 'auto', profile: 'web', homeDir: '', checkoutRoot: '/home/hui/workspace/tools/deepseek-harness' });
    assert.ok(plain.includes("'/home/hui/workspace/tools/deepseek-harness'"), plain.split('\\n').slice(-1)[0]);
    const quoted = buildReadScript({ nodeCommand: 'auto', profile: 'web', homeDir: '', checkoutRoot: "/tmp/a'; touch /tmp/x; #" });
    assert.ok(quoted.includes("'/tmp/a'\\''; touch /tmp/x; #'"), '检出根里的单引号也必须转义');
    // 不给就是不给：脚本末尾只有 profileDir 与 profile 两个参数（不追加空串）
    const none = buildReadScript({ nodeCommand: 'auto', profile: 'web', homeDir: '/home/hui' });
    assert.ok(none.trimEnd().endsWith("'web'"), none.split('\\n').slice(-1)[0]);
});
test("nodeCommand='auto'：脚本自己找 node（PATH → staging），找不到就 exit 5", () => {
    const script = buildReadScript({ nodeCommand: 'auto', profile: 'web', homeDir: '/home/hui' });
    assert.match(script, /command -v node/);
    assert.match(script, /\.dsh-remote-cr\/staging\/\*\/bin\/node/);
    assert.match(script, /REMOTE_CR_NO_NODE >&2; exit 5/);
    assert.match(script, /PATH=\$\(dirname "\$N"\):\$PATH "\$N" "\$f"/);
});
test('注入面：homeDir / profile 里的单引号也必须转义（reader 脚本同一套 shellQuote）', () => {
    const script = buildReadScript({ nodeCommand: 'auto', profile: "web'; touch /tmp/x; #", homeDir: "/home/o'brien" });
    assert.ok(script.includes("'web'\\''; touch /tmp/x; #'"), script);
    assert.ok(script.includes("'/home/o'\\''brien/.dsh/profiles/web'\\''; touch /tmp/x; #'"), script);
});
//# sourceMappingURL=read.test.js.map