import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPurgeScript, buildResidueScript, parsePurge, parseResidue } from "./residue.js";
const SAMPLE = [
    'STAGING=/home/hui/.dsh-remote-cr/staging/abc123',
    'STAGING_EXISTS=1',
    'STAGING_KB=204800',
    'INSTANCES=/home/hui/.dsh-remote-cr/instances',
    'INSTANCE=abc123.json|4|4242|1',
    'INSTANCE=dead.json|4|999999|0',
    'DONE=1',
].join('\n');
test('parseResidue：staging 与 instances 都按远端报的原样落进结构', () => {
    const report = parseResidue(SAMPLE, 'wsl:ubuntu_dev', '2026-11-19T00:00:00.000Z');
    assert.equal(report.targetId, 'wsl:ubuntu_dev');
    assert.deepEqual(report.staging, { path: '/home/hui/.dsh-remote-cr/staging/abc123', exists: true, kb: 204800 });
    assert.equal(report.instances.path, '/home/hui/.dsh-remote-cr/instances');
    assert.equal(report.instances.files.length, 2);
    assert.deepEqual(report.instances.files[0], { name: 'abc123.json', kb: 4, pid: 4242, alive: true });
    assert.equal(report.instances.files[1]?.alive, false, 'pid 已死的登记要能看出来（purge 依据）');
});
test('parseResidue：认不出的行跳过，不编造字段', () => {
    const report = parseResidue('noise\nSTAGING_EXISTS=0\nSTAGING_KB=x\n', 'ssh:a', 't');
    assert.equal(report.staging.exists, false);
    assert.equal(report.staging.kb, 0, '非数字按 0，不报 NaN');
    assert.deepEqual(report.instances.files, []);
});
test('buildResidueScript：POSIX 路径 + 引号，不出现反斜杠', () => {
    const script = buildResidueScript('/home/hui', 'abc123');
    assert.ok(script.includes("'/home/hui/.dsh-remote-cr/staging/abc123'"), script);
    assert.equal(script.includes('\\\\'), false, '远端 bash 会把反斜杠当转义符');
    assert.ok(script.includes('STAGING_EXISTS'), '盘点必须显式报告存在与否');
});
test('buildResidueScript：没有 stagingSuffix 时盘整个 staging 目录（WSL）', () => {
    const script = buildResidueScript('/home/hui', undefined);
    assert.ok(script.includes("'/home/hui/.dsh-remote-cr/staging'"), script);
});
test('buildPurgeScript：只删 staging 与「pid 已死」的登记', () => {
    const script = buildPurgeScript('/home/hui', 'abc123');
    assert.ok(script.includes('rm -rf'), 'staging 整目录删除');
    assert.ok(script.includes('/proc/$pid'), '判活要先看 /proc：kill -0 对别人的进程是 EPERM，会误判成已死');
    assert.ok(script.includes('cut -d,'), 'pid 用 cut/tr 取：不需要在内层引号里写正则，最不易被远端 shell 吃字');
    assert.ok(script.includes('[ -z "$pid" ]'), 'pid 读不出来时必须不删（宁可留垃圾也不删活实例）');
    assert.ok(script.includes('continue'), '活着就 continue，不能落到 rm');
    assert.ok(script.includes("'/home/hui/.dsh-remote-cr/instances'"), script);
});
test('parsePurge：按 kind 汇总并累加释放量', () => {
    const result = parsePurge('REMOVED_STAGING=/s/abc|204800\nREMOVED_INSTANCE=dead.json|4\nDONE=1\n');
    assert.deepEqual(result.removed, [
        { kind: 'staging', path: '/s/abc', kb: 204800 },
        { kind: 'instance', path: 'dead.json', kb: 4 },
    ]);
    assert.equal(result.freedKb, 204804);
});
test('parsePurge：什么都没删时给空清单而不是 undefined', () => {
    const result = parsePurge('DONE=1\n');
    assert.deepEqual(result.removed, []);
    assert.equal(result.freedKb, 0);
});
//# sourceMappingURL=residue.test.js.map