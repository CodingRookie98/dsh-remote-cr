import assert from 'node:assert/strict';
import test from 'node:test';
import { WSL_MIN_EXEC_MS, WSL_TIMEOUT_MARK, createSyncRoutesOptions, defaultWslRun } from "./wire.js";
const TARGET = { backend: 'ssh', alias: 'demo', port: 22, remoteRoot: '/home/hui/workspace' };
const WSL_TARGET = {
    backend: 'wsl',
    distro: 'ubuntu_dev',
    port: 8899,
    remoteRoot: '/home/hui/workspace/tools/deepseek-harness',
};
function wiring(overrides = {}) {
    const calls = [];
    const wslCalls = [];
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
        runInDistro: async (executable, distro, command, options) => {
            wslCalls.push({ executable, distro, command, options });
            return overrides.wsl ?? { stdoutText: '{}', stderrText: '', exitCode: 0 };
        },
        ...(overrides.wslExecutable === undefined ? {} : { wslExecutable: overrides.wslExecutable }),
    });
    return { options, calls, wslCalls };
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
test('WSL 目标：解析出 SyncBackend（dsh 走检出，检出根作为读取提示）', async () => {
    const { options } = wiring();
    const backend = await options.resolve(WSL_TARGET);
    assert.equal(backend.nodeCommand, 'auto');
    assert.equal(backend.dshCommand, '/home/hui/workspace/tools/deepseek-harness/apps/cli/lib/bin.js');
    assert.equal(backend.checkoutRoot, '/home/hui/workspace/tools/deepseek-harness');
    assert.equal(backend.nodeBin, '', 'WSL 还没有确定的 node bin：不拼 PATH 前缀，等 runtime 回报');
});
test('WSL 目标：exec 走 wsl.exe -d <distro> --exec sh -c <脚本>，脚本不再二次转义（变异点 M1）', async () => {
    const { options, wslCalls } = wiring({ wsl: { stdoutText: 'ok', stderrText: '', exitCode: 0 } });
    const backend = await options.resolve(WSL_TARGET);
    const out = await backend.exec("echo 'hi'", 4321);
    assert.deepEqual(out, { code: 0, stdout: 'ok', stderr: '' });
    const call = wslCalls[0];
    assert.equal(call.executable, 'wsl.exe');
    assert.equal(call.distro, 'ubuntu_dev');
    assert.deepEqual(call.command.slice(0, 2), ['sh', '-c']);
    assert.equal(call.command.length, 3);
    assert.equal(call.command[2], "echo 'hi'", '--exec 原样送 argv：再 shellQuote 一次就成了带引号的命令名');
    assert.equal(call.options.timeoutMs, WSL_MIN_EXEC_MS, '冷启动地板：小的 deadline 被抬到下限');
    // 断言**事实下界**而不是符号：地板被改成 5_000 时，符号相等照样绿（2026-11-18 审查的存活变异）。
    // 依据：真机 ubuntu_dev 冷启动第一次读取 18.3 s（热态 0.27 s），地板必须显著高于它。
    assert.ok(WSL_MIN_EXEC_MS >= 45_000, '地板必须覆盖冷启动实测 18.3 s 并留出余量：' + String(WSL_MIN_EXEC_MS));
});
test('WSL 目标：deadline 只抬下限不压上限（apply 的 180s 原样保留）', async () => {
    const { options, wslCalls } = wiring();
    const backend = await options.resolve(WSL_TARGET);
    await backend.exec('x', 180_000);
    assert.equal(wslCalls[0].options.timeoutMs, 180_000);
    await backend.exec('x', WSL_MIN_EXEC_MS + 1);
    assert.equal(wslCalls[1].options.timeoutMs, WSL_MIN_EXEC_MS + 1);
});
test('SSH 兜底 nodeBin 是空串而不是 \'.\'（R2-S4：PATH=\'.\' 会跑远端同名文件）', async () => {
    const { options } = wiring();
    const backend = await options.resolve(TARGET);
    assert.equal(backend.nodeBin, '', '空串 = 不加 PATH 前缀；\'.\' 会把远端 cwd 排在最前');
    assert.equal(backend.stagingSuffix !== undefined && backend.stagingSuffix.startsWith('.dsh-remote-cr/staging/'), true, 'staging 必须按目标算后缀');
});
test('WSL 不传 staging 后缀：连接面只认检出（显式决定，写进契约）', async () => {
    const { options } = wiring();
    const backend = await options.resolve(WSL_TARGET);
    assert.equal(backend.stagingSuffix, undefined);
});
test('WSL 目标：wsl.exe 可执行文件可注入（多套装 WSL 时用得上）', async () => {
    const { options, wslCalls } = wiring({ wslExecutable: 'C:/Windows/System32/wsl.exe' });
    const backend = await options.resolve(WSL_TARGET);
    await backend.exec('true', 1000);
    assert.equal(wslCalls[0].executable, 'C:/Windows/System32/wsl.exe');
});
test('默认执行面真的把诊断挂上（BLK-1：换回 runInDistro 时这条必须红）', async () => {
    const calls = [];
    const checked = (async (executable, distro, command, options) => {
        calls.push({ executable, distro, command, options });
        return {
            result: {
                exitCode: 1,
                signal: null,
                stdout: new Uint8Array(),
                stderr: new Uint8Array(),
                timedOut: false,
                stdoutText: '',
                stderrText: '',
            },
            diagnosis: {
                code: 'wsl/start-failed',
                detail: '发行版起不来：0x8007019e',
                nextActions: [],
                wslCode: '0x8007019e',
                logTail: 'WslRegisterDistribution failed',
            },
        };
    });
    const out = await defaultWslRun('wsl.exe', 'ubuntu_dev', ['sh', '-c', 'true'], { timeoutMs: 1000 }, checked);
    assert.equal(calls.length, 1, '默认执行面必须真的去跑（不是凭空编结果）');
    assert.equal(calls[0].distro, 'ubuntu_dev');
    assert.equal(out.diagnosis?.detail, '发行版起不来：0x8007019e', '诊断必须原样透传给上层拼 stderr');
    assert.equal(out.exitCode, 1);
});
test('WSL 目标：wsl.exe 自己的失败诊断进 stderr 尾巴（B2：stdout 是 UTF-16LE，stderr 是空的）', async () => {
    const { options } = wiring({
        wsl: {
            stdoutText: 'W\u0000s\u0000l\u0000',
            stderrText: '',
            exitCode: 1,
            diagnosis: { code: 'wsl/start-failed', detail: '发行版 ubuntu_dev 启动失败：0x8007019e', logTail: 'WslRegisterDistribution failed' },
        },
    });
    const backend = await options.resolve(WSL_TARGET);
    const out = await backend.exec('x', 1000);
    assert.equal(out.code, 1);
    assert.match(out.stderr, /0x8007019e/, '诊断 detail 必须出现在日志里，否则用户只知道「退出码 1」');
    assert.match(out.stderr, /WslRegisterDistribution/);
});
test('WSL 目标：超时一律记 124，即便 wsl.exe 报 exitCode 0（被杀不能记成成功）', async () => {
    const { options } = wiring({ wsl: { stdoutText: 'ok', stderrText: '', exitCode: 0, timedOut: true } });
    const backend = await options.resolve(WSL_TARGET);
    const out = await backend.exec('x', 1000);
    assert.equal(out.code, 124, 'Windows 上 child.kill() 常回 0/1，只看 exitCode 会把半装记成成功');
    assert.match(out.stderr, new RegExp(WSL_TIMEOUT_MARK));
});
test('WSL 目标：超时与非零退出分开报（exitCode null 不冒充成功）', async () => {
    const timedOut = wiring({ wsl: { stdoutText: '', stderrText: 'killed', exitCode: null, timedOut: true } });
    const backend = await timedOut.options.resolve(WSL_TARGET);
    const out = await backend.exec('x', 1000);
    assert.equal(out.code, 124);
    assert.match(out.stderr, new RegExp(WSL_TIMEOUT_MARK));
    const killed = wiring({ wsl: { stdoutText: '', stderrText: 'boom', exitCode: null } });
    const other = await killed.options.resolve(WSL_TARGET);
    const plain = await other.exec('x', 1000);
    assert.equal(plain.code, 1, '没有超时标记的 null 退出码按 1 报，留给上层 read-failed/apply-failed');
    assert.equal(plain.stderr, 'boom');
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
    // 发行版名大小写不敏感：不归一化会让 `wsl:Ubuntu_Dev` 绕过静音与并发锁（同一 distro 两路 pnpm 互踩）。
    assert.equal(await options.targetId({ backend: 'wsl', distro: 'Ubuntu_Dev', port: 8899, remoteRoot: '/x' }), 'wsl:ubuntu_dev');
});
//# sourceMappingURL=wire.test.js.map