import assert from 'node:assert/strict';
import test from 'node:test';
import { applyLiveness, buildLivenessScript, buildPurgeScript, buildResidueScript, parsePurge, parseResidue, planPurge, stagingIdOf, } from "./residue.js";
const SAMPLE = [
    'STAGING=/home/hui/.dsh-remote-cr/staging/abc123',
    'STAGING_EXISTS=1',
    'STAGING_KB=204800',
    'INSTANCES=/home/hui/.dsh-remote-cr/instances',
    'INSTANCE_BEGIN=live.json|4',
    '{"version":1,"pid":4242,"port":8941,"token":"t"}',
    'INSTANCE_END',
    'INSTANCE_BEGIN=dead.json|4',
    '{"version":1,"pid":999999,"port":8942,"token":"t"}',
    'INSTANCE_END',
    'INSTANCE_BEGIN=broken.json|4',
    'not json at all',
    'INSTANCE_END',
    'INSTANCE_BEGIN=v2.json|4',
    '{"version":2,"pid":999998}',
    'INSTANCE_END',
    'DONE=1',
].join('\n');
test('stagingIdOf：只认 .dsh-remote-cr/staging/<id>，其余一律抛（不猜路径）', () => {
    assert.equal(stagingIdOf('.dsh-remote-cr/staging/a5ee8a633c91470f'), 'a5ee8a633c91470f');
    assert.equal(stagingIdOf(undefined), null, 'undefined = 整个 staging（WSL）');
    assert.throws(() => stagingIdOf('.dsh-remote-cr/staging/../x'), /不是/, '`..` 必须被拒');
    assert.throws(() => stagingIdOf('.dsh-remote-cr/staging/'), /不是/);
    assert.throws(() => stagingIdOf('random/path'), /不是/);
});
test('buildResidueScript：路径只由 $HOME 拼，脚本里没有外部绝对路径', () => {
    const script = buildResidueScript('abc123');
    assert.ok(script.includes('"$HOME/.dsh-remote-cr/staging/abc123"'), script);
    assert.ok(script.includes('"$HOME/.dsh-remote-cr/instances"'), script);
    assert.equal(/\/home\//.test(script), false, '不许把任何具体 home 写进脚本（v1 的 N0 就出在这）');
});
test('buildResidueScript：id 为 null 或 undefined 都盘整个 staging（WSL 的 distro 级目录）', () => {
    for (const empty of [null, undefined]) {
        const script = buildResidueScript(empty);
        assert.ok(script.includes('"$HOME/.dsh-remote-cr/staging"'), script);
        assert.equal(script.includes('staging/undefined'), false, 'undefined 不许拼进路径（真机踩到过）');
    }
});
test('parseResidue：JSON 在 TS 里解析，坏 JSON 的 pid 记 null', () => {
    const report = parseResidue(SAMPLE, 'ssh:a', '2026-11-19T00:00:00.000Z');
    assert.equal(report.staging.path, '/home/hui/.dsh-remote-cr/staging/abc123');
    assert.equal(report.staging.kb, 204800);
    assert.equal(report.instances.files.length, 4);
    assert.deepEqual(report.instances.files[0], { name: 'live.json', kb: 4, pid: 4242, version: 1, alive: false });
    assert.equal(report.instances.files[2]?.pid, null, '坏 JSON 的 pid 必须是 null（purge 据此不删）');
});
test('applyLiveness：只把脚本报的 ALIVE pid 标活', () => {
    const report = parseResidue(SAMPLE, 'ssh:a', 't');
    const merged = applyLiveness(report, 'ALIVE=4242\nDONE=1\n');
    assert.equal(merged.instances.files[0]?.alive, true);
    assert.equal(merged.instances.files[1]?.alive, false);
});
test('planPurge：只删「version=1 且 pid 非空且已死」的登记', () => {
    const report = applyLiveness(parseResidue(SAMPLE, 'ssh:a', 't'), 'ALIVE=4242\nDONE=1\n');
    const plan = planPurge(report);
    // 样本里 live.json 活着 → staging 不删（见下一条用例）：这条只验「哪些登记进计划」。
    assert.equal(plan.removeStaging, false);
    assert.deepEqual(plan.instances.map((file) => file.name), ['dead.json'], '活的、坏 JSON 的、version≠1 的都不许进清理计划');
});
test('buildResidueScript/Purge：$HOME 不是绝对路径时脚本自己退出（P4 Delta P2）', () => {
    for (const script of [buildResidueScript(null), buildPurgeScript(null, { removeStaging: true, skipReason: null, instances: [] })]) {
        assert.ok(script.includes('HOME_INVALID=1'), script);
        assert.ok(script.includes('exit 2'), '守卫必须真的退出，而不是继续往下删');
    }
});
test('planPurge：只碰本 anchor 的 instances/<id>.json（instances 目录是跨 anchor 共享的）', () => {
    const sample = [
        'STAGING=/h/.dsh-remote-cr/staging/abc123',
        'STAGING_EXISTS=1',
        'STAGING_KB=1',
        'INSTANCES=/h/.dsh-remote-cr/instances',
        'INSTANCE_BEGIN=abc123.json|4',
        '{"version":1,"pid":999991}',
        'INSTANCE_END',
        'INSTANCE_BEGIN=other-anchor.json|4',
        '{"version":1,"pid":999992}',
        'INSTANCE_END',
        'DONE=1',
    ].join('\n');
    const report = parseResidue(sample, 'ssh:a', 't');
    assert.deepEqual(planPurge(report, 'abc123').instances.map((file) => file.name), ['abc123.json']);
    assert.deepEqual(planPurge(report, null).instances.map((file) => file.name), ['abc123.json', 'other-anchor.json'], 'WSL 是 distro 级：没有 id 时才允许清全部死登记');
});
test('judgment unknown：hidepid=2 下判活拿不准时必须失败关闸（真机容器实测）', () => {
    const script = buildLivenessScript([4242]);
    assert.match(script, /hidepid=/, '脚本要先看 /proc 有没有 hidepid');
    assert.match(script, /UNKNOWN=/, '拿不准要单独回 UNKNOWN，不能当已死');
    const scanned = parseResidue(SAMPLE, 'ssh:a', 't');
    const withUnknown = applyLiveness(scanned, 'UNKNOWN=4242\nDONE=1\n');
    assert.deepEqual(withUnknown.instances.unknown, [4242]);
    const plan = planPurge(withUnknown);
    assert.equal(plan.removeStaging, false, '判活拿不准时不许删 staging');
    assert.equal(plan.skipReason, 'liveness-unknown');
    assert.deepEqual(plan.instances.map((file) => file.name), ['dead.json'], '拿不准的那个不许进计划；能确认已死的照常进');
    // hidepid 下**所有**非本用户的 pid 都会变 UNKNOWN（连真死的也一样）：这时计划必须全空。
    const allUnknown = applyLiveness(scanned, 'UNKNOWN=4242\nUNKNOWN=999999\nDONE=1\n');
    const strict = planPurge(allUnknown);
    assert.deepEqual(strict.instances, [], '一个都拿不准时，一个都不许删');
    assert.equal(strict.removeStaging, false);
});
test('planPurge：只要有活着的驻留实例就不删 staging（P4 Delta P1）', () => {
    const report = applyLiveness(parseResidue(SAMPLE, 'ssh:a', 't'), 'ALIVE=4242\nDONE=1\n');
    const plan = planPurge(report);
    assert.equal(plan.removeStaging, false, '活实例的 node/dsh 就在 staging 里，删了进程还在但再也起不来');
    assert.equal(plan.skipReason, 'resident-alive');
});
test('buildPurgeScript：逐条 rm 并检查退出码，失败要能上报', () => {
    const script = buildPurgeScript('abc123', {
        removeStaging: true,
        skipReason: null,
        instances: [{ name: 'dead.json', kb: 4, pid: 999999, version: 1, alive: false }],
    });
    assert.ok(script.includes('if rm -rf "$S"; then echo "REMOVED_STAGING'), script);
    assert.ok(script.includes('else echo "FAILED_STAGING='), 'rm 失败必须走 FAILED 分支，不能无条件报成功');
    assert.ok(script.includes('rm -f "$I/dead.json"'), script);
});
test('parsePurge：失败行单独收集，不进 removed', () => {
    const result = parsePurge('REMOVED_STAGING=/s/abc|204800\nFAILED_INSTANCE=dead.json\nDONE=1\n');
    assert.equal(result.removed.length, 1);
    assert.equal(result.freedKb, 204800);
    assert.deepEqual(result.failures, ['instance:dead.json']);
});
test('buildLivenessScript：只接受正整数 pid，其余过滤掉', () => {
    const script = buildLivenessScript([42, Number.NaN, -1, 0]);
    assert.ok(script.includes('for p in 42;'), script);
    assert.ok(script.includes('[ -d "/proc/$p" ]'), '先看 /proc（权限无关），再退回 kill -0');
    assert.equal(buildLivenessScript([]), 'echo DONE=1');
});
//# sourceMappingURL=residue.test.js.map