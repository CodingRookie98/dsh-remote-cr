/**
 * 这一层决定「远端 dsh 从哪来」，而它的全部输入就是**一条**远端脚本的输出。
 * 所以测试的形态是：给一段假 stdout（标记行），断言走了哪条分支、报什么码、跑了几次往返。
 * 脚本正文本身由 `buildInspectScript` 负责，测试不锁它的字面量——锁的是**判定**。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RemoteCrError } from "../errors.js";
import { resolveRemoteDsh } from "./runtime.js";
const TARGET = {
    alias: 'gcp',
    hostName: '10.0.0.9',
    user: 'hui',
    port: 22,
    proxyJump: [],
    identityFiles: ['/home/hui/.ssh/id_gcp'],
    source: { file: 'C:/Users/hui/.ssh/config', line: 60 },
};
const REMOTE_ROOT = '/home/hui/workspace';
/** 造一条与 `buildInspectScript` 同形的 stdout（标记行，末行 END）。 */
function inspectOut(shape) {
    const lines = [
        'REMOTE_CR_HOME=' + (shape.home ?? '/home/hui'),
        'REMOTE_CR_NODE=' + (shape.node ?? 'v22.22.1'),
        'REMOTE_CR_DSH=' + (shape.dsh ?? ''),
    ];
    if (shape.dir !== false)
        lines.push('REMOTE_CR_DIR=1');
    if (shape.checkout === true)
        lines.push('REMOTE_CR_CHECKOUT=1');
    if (shape.staging !== undefined)
        lines.push('REMOTE_CR_STAGING=' + shape.staging);
    if (shape.stagingNode === true)
        lines.push('REMOTE_CR_STAGING_NODE=1');
    if (shape.truncated !== true)
        lines.push('REMOTE_CR_END=1');
    return lines.join(String.fromCharCode(10)) + String.fromCharCode(10);
}
/**
 * 第一段（检查脚本）回 `inspectOut(...)`；其余由 `rest` 决定，没命中就给 exit 1——
 * 让「漏了一条分支」立刻红，而不是静默通过。
 */
function fakeExec(shape, rest = () => ({ code: 0, stdout: '', stderr: '' })) {
    const calls = [];
    return {
        calls,
        exec: async (script, deadlineMs) => {
            calls.push({ script, deadlineMs });
            // 检查脚本用 `p REMOTE_CR_HOME "$HOME"` 的形式问，不是字面量 `=`。
            if (script.includes('p REMOTE_CR_HOME'))
                return { code: 0, stdout: inspectOut(shape), stderr: '' };
            return rest(script) ?? { code: 1, stdout: '', stderr: 'unexpected script' };
        },
    };
}
const base = (home, extra = {}) => ({ homeDir: home, target: TARGET, auth: { kind: 'key' }, remoteRoot: REMOTE_ROOT, ...extra });
const stateDirOf = (home) => join(home, '.dsh-remote-cr', 'bootstrap');
function rethrowAsRemoteCr(error, code, extra) {
    assert.ok(error instanceof RemoteCrError, '应是 RemoteCrError，实际 ' + String(error));
    assert.equal(error.code, code);
    extra?.(error);
    return true;
}
test('有检出就用检出：argvPrefix 是 node + 检出里的 bin.js，且只跑一条远端命令', async () => {
    const home = mkdtempSync(join(tmpdir(), 'remote-cr-runtime-'));
    const { exec, calls } = fakeExec({ dir: true, checkout: true });
    try {
        const runtime = await resolveRemoteDsh(base(home, { exec }));
        assert.equal(runtime.source, 'checkout');
        assert.deepEqual(runtime.argvPrefix, ['node', REMOTE_ROOT + '/apps/cli/lib/bin.js']);
        assert.equal(runtime.dshRoot, REMOTE_ROOT);
        assert.equal(calls.length, 1, '检出路径只该花一次远端往返');
    }
    finally {
        rmSync(home, { recursive: true, force: true });
    }
});
test('远端目录不存在：remote/path-unreadable，且在 detail 里写出那个目录', async () => {
    const home = mkdtempSync(join(tmpdir(), 'remote-cr-runtime-'));
    const { exec } = fakeExec({ dir: false });
    try {
        await assert.rejects(() => resolveRemoteDsh(base(home, { exec })), (error) => rethrowAsRemoteCr(error, 'remote/path-unreadable', (item) => {
            assert.ok(item.detail.includes('/home/hui/workspace'), item.detail);
        }));
    }
    finally {
        rmSync(home, { recursive: true, force: true });
    }
});
test('staging 装过就复用：一次往返、不装任何东西', async () => {
    const home = mkdtempSync(join(tmpdir(), 'remote-cr-runtime-'));
    const { exec, calls } = fakeExec({ dir: true, staging: '0.2.2-rc.1', stagingNode: true });
    try {
        const runtime = await resolveRemoteDsh(base(home, { exec }));
        assert.equal(runtime.source, 'staging');
        const argv = runtime.argvPrefix;
        // 末项是 dsh 入口；首项是 staging 的 node（dsh 的 shebang 依赖 PATH，显式带 node 才不挑远端环境）。
        assert.match(argv[argv.length - 1] ?? '', /\/\.dsh-remote-cr\/staging\/[0-9a-f]{16}\/npm\/bin\/dsh$/);
        assert.match(argv[0] ?? '', /\/bin\/node$/, 'staging 的 dsh 必须用 staging 的 node 执行');
        assert.equal(runtime.dshRoot.split('/').pop()?.length, 16, 'dshRoot 应是 staging/<16 位 id>');
        assert.equal(calls.length, 1, '复用路径只该花一次远端往返：这是首连 ≤10s 门禁的关键');
    }
    finally {
        rmSync(home, { recursive: true, force: true });
    }
});
test('staging 没装过就装，装完必须验版本，账本落本地', async () => {
    const home = mkdtempSync(join(tmpdir(), 'remote-cr-runtime-'));
    const scripts = [];
    const { exec } = fakeExec({ dir: true }, (script) => {
        scripts.push(script);
        if (/npm\/bin\/dsh' --version/.test(script))
            return { code: 0, stdout: '0.2.2-rc.1' + String.fromCharCode(10), stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
    });
    try {
        const runtime = await resolveRemoteDsh(base(home, { exec, stateDir: stateDirOf(home) }));
        assert.equal(runtime.source, 'staging');
        assert.ok(scripts.length > 1, '没有真的跑引导脚本');
        const id = runtime.dshRoot.split('/').pop() ?? '';
        const ledger = readFileSync(join(stateDirOf(home), id + '.json'), 'utf8');
        assert.match(ledger, /"steps"/, '账本没有落盘：下次会重装一遍');
    }
    finally {
        rmSync(home, { recursive: true, force: true });
    }
});
test('装完却跑不出可用版本：remote/bootstrap-failed，输出写明（空）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'remote-cr-runtime-'));
    const { exec } = fakeExec({ dir: true }, () => ({ code: 0, stdout: String.fromCharCode(10), stderr: '' }));
    try {
        await assert.rejects(() => resolveRemoteDsh(base(home, { exec, stateDir: stateDirOf(home) })), (error) => rethrowAsRemoteCr(error, 'remote/bootstrap-failed', (item) => {
            assert.equal(item.phase, 'bootstrap');
            assert.ok(item.detail.includes('（空）'), item.detail);
        }));
    }
    finally {
        rmSync(home, { recursive: true, force: true });
    }
});
test('检查脚本没跑完（缺 END）：remote/probe-incomplete，不把「什么都没问出来」当成「都没有」', async () => {
    const home = mkdtempSync(join(tmpdir(), 'remote-cr-runtime-'));
    const { exec } = fakeExec({ dir: true, truncated: true });
    try {
        await assert.rejects(() => resolveRemoteDsh(base(home, { exec })), (error) => rethrowAsRemoteCr(error, 'remote/probe-incomplete'));
    }
    finally {
        rmSync(home, { recursive: true, force: true });
    }
});
test('远端 home 为空：remote/dsh-missing，因为没有 home 就没有 staging 位置', async () => {
    const home = mkdtempSync(join(tmpdir(), 'remote-cr-runtime-'));
    const { exec } = fakeExec({ dir: true, home: '' });
    try {
        await assert.rejects(() => resolveRemoteDsh(base(home, { exec })), (error) => rethrowAsRemoteCr(error, 'remote/dsh-missing'));
    }
    finally {
        rmSync(home, { recursive: true, force: true });
    }
});
test('stagingArgv：复用系统 node 时用 PATH 上的 node，不写死 staging/bin/node（真机回归）', async () => {
    const { stagingArgv } = await import("./runtime.js");
    assert.deepEqual(stagingArgv('/s', '/s/npm/bin/dsh', false), ['node', '/s/npm/bin/dsh']);
    assert.deepEqual(stagingArgv('/s', '/s/npm/bin/dsh', true), ['/s/bin/node', '/s/npm/bin/dsh']);
});
//# sourceMappingURL=runtime.test.js.map