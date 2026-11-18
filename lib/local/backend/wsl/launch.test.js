import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDshArgs, buildLaunchArgs, buildWatchdogScript, WATCHDOG_KILLED_MARK, WATCHDOG_PID_MARK } from "./launch.js";
const base = { distro: 'ubuntu_dev', remoteRoot: '/home/hui/workspace/tools/deepseek-harness', port: 8899 };
test('dsh 的 argv 是显式的 --no-open --port --host，不依赖远端默认值', () => {
    assert.deepEqual(buildDshArgs(base), [
        'node',
        'apps/cli/lib/bin.js',
        'web',
        '--no-open',
        '--port',
        '8899',
        '--host',
        '127.0.0.1',
    ]);
});
test('nodeCommand 可替换：T6 的「远端无 node」失败路径靠它', () => {
    const args = buildDshArgs({ ...base, nodeCommand: 'node-missing-remote-cr' });
    assert.equal(args[0], 'node-missing-remote-cr');
});
test('工作目录走 wsl --cd，而不是 spawn 的 cwd（后者是 Windows 路径）', () => {
    const args = buildLaunchArgs(base);
    assert.deepEqual(args.slice(0, 5), ['-d', 'ubuntu_dev', '--cd', base.remoteRoot, '--exec']);
    assert.equal(args.includes('--cd'), true);
});
test('发行版名含空格时仍是一个 argv 元素', () => {
    const args = buildLaunchArgs({ ...base, distro: 'Ubuntu 22.04 LTS' });
    assert.equal(args[1], 'Ubuntu 22.04 LTS');
    // -d <distro> --cd <root> --exec bash -lc <script> = 8 段
    assert.equal(args.length, 8);
    assert.deepEqual(args.slice(5, 7), ['bash', '-lc']);
});
test('远端 dsh 被包进「stdin 一关就自杀」的看门狗：宿主崩溃也不留孤儿', () => {
    const script = buildWatchdogScript(base);
    // 单行是硬要求：wsl.exe --exec 把多行当成后续命令输入。
    assert.equal(script.includes('\n'), false, '看门狗脚本必须是单行');
    assert.ok(script.includes(WATCHDOG_PID_MARK), '要打印子进程 pid，回收实证靠它');
    assert.ok(script.includes(WATCHDOG_KILLED_MARK), '要打印回收标记，实证靠它确认走的是这条路');
    assert.ok(script.includes('cat > /dev/null'), '阻塞在 stdin 上，直到宿主关管道');
    assert.ok(script.includes('kill $child'), 'EOF 之后 kill 子进程');
    // 真正的 dsh 命令仍完整在里面（argv 被原样拼进去）
    for (const part of buildDshArgs(base).slice(1)) {
        assert.ok(script.includes(part), '看门狗脚本里少了 dsh 的参数 ' + part);
    }
});
test('NEGATIVE_CONTROL 可假性：看门狗里去掉 kill 必须让上面那条断言失败', () => {
    const script = buildWatchdogScript(base);
    const mutated = process.env.NEGATIVE_CONTROL === '1' ? script.replace('kill $child', 'true') : script;
    assert.ok(mutated.includes('kill $child'), 'EOF 之后不 kill 就留孤儿');
});
test('extraArgs 追加在末尾，不覆盖已有参数', () => {
    const args = buildDshArgs({ ...base, extraArgs: ['--verbose'] });
    assert.equal(args.at(-1), '--verbose');
    assert.equal(args.filter((a) => a === '--port').length, 1);
});
test('NEGATIVE_CONTROL 可假性：把 --cd 去掉必须让上面那条断言失败', () => {
    const args = process.env.NEGATIVE_CONTROL === '1'
        ? buildLaunchArgs(base).filter((a) => a !== '--cd' && a !== base.remoteRoot)
        : buildLaunchArgs(base);
    if (process.env.NEGATIVE_CONTROL === '1') {
        assert.equal(args.includes('--cd'), true, '没有 --cd 就该红');
        return;
    }
    assert.equal(args.includes('--cd'), true);
});
//# sourceMappingURL=launch.test.js.map