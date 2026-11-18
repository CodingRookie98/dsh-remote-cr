import assert from 'node:assert/strict';
import test from 'node:test';
import { runInDistroChecked } from "./exec.js";
function runner(failure) {
    let calls = 0;
    return {
        calls: () => calls,
        run: async () => {
            calls += 1;
            return {
                exitCode: failure.exitCode,
                signal: null,
                stdout: failure.stdout,
                stderr: failure.stderr,
                timedOut: failure.timedOut ?? false,
                stdoutText: Buffer.from(failure.stdout).toString('utf8'),
                stderrText: Buffer.from(failure.stderr).toString('utf8'),
            };
        },
    };
}
/** 真机字节（2026-11-14 本机实测同款）：`wsl.exe` 的启动失败在 stdout，UTF-16LE。 */
function utf16le(text) {
    return new Uint8Array(Buffer.from(text, 'utf16le'));
}
test('非零退出：把原始字节交给诊断层，UTF-16LE 的 stdout 也能读出人话', async () => {
    const fake = runner({
        exitCode: -1,
        // 真实形态：失败正文在 stdout、UTF-16LE、带一行 `Error code:`（对照 diagnosis.test.ts 的真机字节）
        stdout: utf16le('Failed to attach disk.\nError code: Wsl/Service/CreateInstance/MountDisk/HCS/E_INVALIDARG\n'),
        stderr: new Uint8Array(),
    });
    const checked = await runInDistroChecked('wsl.exe', 'ubuntu_dev', ['sh', '-c', 'true'], {}, fake.run);
    assert.equal(fake.calls(), 1, '必须真的调用执行面（不是凭空编诊断）');
    assert.notEqual(checked.diagnosis, null, '非零退出必须产出诊断');
    assert.equal(checked.diagnosis?.wslCode, 'Wsl/Service/CreateInstance/MountDisk/HCS/E_INVALIDARG');
    assert.match(String(checked.diagnosis?.detail), /ubuntu_dev/);
});
test('成功不编诊断：exitCode 0 且未超时 → diagnosis 为 null', async () => {
    const fake = runner({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() });
    const checked = await runInDistroChecked('wsl.exe', 'ubuntu_dev', ['sh', '-c', 'true'], {}, fake.run);
    assert.equal(checked.diagnosis, null, '成功时编诊断会让 UI 显示一张假错误卡');
});
test('超时也算失败：exitCode 0 + timedOut 必须给出诊断（被杀不能当成功）', async () => {
    const fake = runner({ exitCode: 0, timedOut: true, stdout: new Uint8Array(), stderr: new Uint8Array() });
    const checked = await runInDistroChecked('wsl.exe', 'ubuntu_dev', ['sh', '-c', 'true'], { timeoutMs: 1 }, fake.run);
    assert.notEqual(checked.diagnosis, null);
    assert.equal(checked.diagnosis?.code, 'wsl/timeout');
});
//# sourceMappingURL=exec.test.js.map