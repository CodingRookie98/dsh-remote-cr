import assert from 'node:assert/strict';
import test from 'node:test';
import { LOG_TAIL_LIMIT, decodeWslDiagnostics, describeWslFailure, extractWslCode } from "./diagnosis.js";
/**
 * 真机字节（2026-11-14 本机实测）：`wsl.exe -d ubuntu_dev --exec ls -1aF -- /` 在发行版
 * 已停止且 vhdx 失效时，**stderr 为空**、**exitCode 为 -1**、stdout 是下面这段的
 * UTF-16LE 无 BOM 编码。测试直接喂原始字节，而不是先解码再断言——解错正是这条缺陷的根因。
 */
const VHDX = String.raw `\\?\D:\My_Tools\wsl2-ubuntu-dev\ext4.vhdx`;
const REAL_STDOUT = [
    `Failed to attach disk '${VHDX}' to WSL2: 系统找不到指定的文件。`,
    'Error code: Wsl/Service/CreateInstance/MountDisk/HCS/E_INVALIDARG',
    'If this error was unexpected, please check that the disk is available.',
    '',
].join('\r\n');
test('真机字节：UTF-16LE 的挂载失败被解成人话，没有 NUL、没有替换符', () => {
    const decoded = decodeWslDiagnostics(Buffer.from(REAL_STDOUT, 'utf16le'));
    assert.equal(decoded.includes('\0'), false, 'UTF-16LE 的 NUL 必须去掉');
    assert.equal(decoded.includes('\uFFFD'), false, '不能留下替换符——那是解错编码的症状');
    assert.equal(decoded.includes('\r'), false, '统一去 CR');
    assert.ok(decoded.includes('Failed to attach disk'), decoded);
    assert.ok(decoded.includes('ext4.vhdx'), decoded);
    assert.equal(decoded.trim(), decoded, '首尾空白要去掉');
});
test('真机字节：抽得出 Wsl/Service/.../E_INVALIDARG，且归类为 wsl/disk-missing', () => {
    const diagnosis = describeWslFailure({
        distro: 'ubuntu_dev',
        exitCode: -1,
        stdout: Buffer.from(REAL_STDOUT, 'utf16le'),
        stderr: new Uint8Array(),
    });
    assert.equal(diagnosis.wslCode, 'Wsl/Service/CreateInstance/MountDisk/HCS/E_INVALIDARG');
    assert.equal(diagnosis.code, 'wsl/disk-missing');
    assert.ok(diagnosis.detail.includes('ubuntu_dev'), diagnosis.detail);
    assert.ok(diagnosis.detail.includes('E_INVALIDARG'), diagnosis.detail);
    // 本地化原文只进 logTail：detail 里出现「系统找不到指定的文件」就是把乱码源搬进了错误卡。
    assert.equal(diagnosis.detail.includes('系统找不到指定的文件'), false, diagnosis.detail);
    assert.ok(diagnosis.logTail.includes('系统找不到指定的文件'), diagnosis.logTail);
    assert.ok(diagnosis.nextActions.some((action) => action.includes('ext4.vhdx')), diagnosis.nextActions.join(' | '));
    assert.ok(diagnosis.nextActions.some((action) => action.includes('wsl --unregister ubuntu_dev')), diagnosis.nextActions.join(' | '));
});
test('not-installed：WSL_E_DISTRO_NOT_FOUND 归到「没装这个发行版」，并给出 wsl --install', () => {
    const text = 'There is no such distro: ubuntu_dev\r\nError code: WSL_E_DISTRO_NOT_FOUND\r\n';
    const diagnosis = describeWslFailure({
        distro: 'ubuntu_dev',
        exitCode: -1,
        stdout: Buffer.from(text, 'utf8'),
        stderr: new Uint8Array(),
    });
    assert.equal(diagnosis.code, 'wsl/not-installed');
    assert.equal(diagnosis.wslCode, 'WSL_E_DISTRO_NOT_FOUND');
    assert.ok(diagnosis.nextActions.some((action) => action.includes('wsl --install')), diagnosis.nextActions.join(' | '));
});
test('access-denied：拒绝访问归到权限问题，不冒充磁盘丢失', () => {
    const text = '拒绝访问。\r\nError code: Wsl/Service/CreateInstance/HCS/E_ACCESSDENIED\r\n';
    const diagnosis = describeWslFailure({
        distro: 'ubuntu_dev',
        exitCode: -1,
        stdout: Buffer.from(text, 'utf8'),
        stderr: new Uint8Array(),
    });
    assert.equal(diagnosis.code, 'wsl/access-denied');
    assert.equal(diagnosis.wslCode, 'Wsl/Service/CreateInstance/HCS/E_ACCESSDENIED');
});
test('空输入（退出码 null + 两个流都空）：如实报 wsl/unknown，不伪装成启动失败', () => {
    const diagnosis = describeWslFailure({
        distro: 'ubuntu_dev',
        exitCode: null,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
    });
    assert.equal(diagnosis.code, 'wsl/unknown');
    assert.equal(diagnosis.wslCode, null);
    assert.equal(diagnosis.logTail, '');
    assert.deepEqual([...diagnosis.nextActions], ['复制诊断贴到 issue']);
});
test('有文本但没有 WSL 码：归 wsl/start-failed，退出码进 detail', () => {
    const diagnosis = describeWslFailure({
        distro: 'ubuntu_dev',
        exitCode: 1,
        stdout: Buffer.from('元素未找到。\r\n', 'utf8'),
        stderr: new Uint8Array(),
    });
    assert.equal(diagnosis.code, 'wsl/start-failed');
    assert.ok(diagnosis.detail.includes('退出码 1'), diagnosis.detail);
});
test('纯本地化的 UTF-16LE 文本（整句没有一个 ASCII）也按 UTF-16LE 解', () => {
    const text = '没有可用的发行版。';
    assert.equal(decodeWslDiagnostics(Buffer.from(text, 'utf16le')), text);
});
test('UTF-8 的命令输出不会被当成 UTF-16LE（ls 自己的报错必须原样可读）', () => {
    const text = "ls: cannot access '/nope': No such file or directory\n";
    assert.equal(decodeWslDiagnostics(Buffer.from(text, 'utf8')), text.trim());
});
test('logTail 只留尾部，最多 800 字符', () => {
    const long = 'x'.repeat(LOG_TAIL_LIMIT) + 'Error code: WSL_E_TAIL\r\n';
    const diagnosis = describeWslFailure({
        distro: 'ubuntu_dev',
        exitCode: -1,
        stdout: Buffer.from(long, 'utf8'),
        stderr: new Uint8Array(),
    });
    assert.equal(diagnosis.logTail.length, LOG_TAIL_LIMIT);
    assert.ok(diagnosis.logTail.endsWith('WSL_E_TAIL'), diagnosis.logTail);
});
test('extractWslCode：优先 Error code: 行，退到 WSL_E_*', () => {
    assert.equal(extractWslCode('Error code: Wsl/Service/X\r\n'), 'Wsl/Service/X');
    assert.equal(extractWslCode('boom WSL_E_DISTRO_NOT_FOUND boom'), 'WSL_E_DISTRO_NOT_FOUND');
    assert.equal(extractWslCode('什么都没有'), null);
});
test('NEGATIVE_CONTROL 可假性：同一份字节按 UTF-8 解必然带 NUL', () => {
    const negate = process.env.NEGATIVE_CONTROL === '1';
    const bytes = Buffer.from(REAL_STDOUT, 'utf16le');
    const wrong = bytes.toString(negate ? 'utf16le' : 'utf8');
    assert.equal(wrong.includes('\0'), true, 'UTF-8 解 UTF-16LE 字节会留下 NUL——这正是今天乱码的证据');
    assert.equal(decodeWslDiagnostics(bytes).includes('\0'), false);
});
test('超时单独归一类：它是“还没起完”，不是“起不来”', () => {
    const diagnosis = describeWslFailure({
        distro: 'ubuntu_dev',
        exitCode: null,
        timedOut: true,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
    });
    assert.equal(diagnosis.code, 'wsl/timeout');
    assert.match(diagnosis.detail, /没有启动完成/);
    assert.ok(diagnosis.nextActions.some((action) => action.includes('重试唤醒')));
});
test('超时的同时 WSL 给了磁盘挂载错误时，仍按磁盘类给出路（信息量更大）', () => {
    const text = 'Failed to attach disk \u0027\\\\?\\D:\\x\\ext4.vhdx\u0027\r\nError code: Wsl/Service/CreateInstance/MountDisk/HCS/E_INVALIDARG\r\n';
    const diagnosis = describeWslFailure({
        distro: 'ubuntu_dev',
        exitCode: null,
        timedOut: true,
        stdout: Buffer.from(text, 'utf16le'),
        stderr: new Uint8Array(),
    });
    assert.equal(diagnosis.code, 'wsl/disk-missing');
});
//# sourceMappingURL=diagnosis.test.js.map