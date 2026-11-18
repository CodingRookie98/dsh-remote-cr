import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteCrError } from "../local/backend/errors.js";
import { FLOW_PHASES, canCancel, cancelFlow, completeFlow, flowProgress, enterPhase, failFlow, flowReport, initialFlow, progressOf, startFlow, } from "./flow.js";
const sampleError = {
    code: 'remote/port-in-use',
    phase: 'launch',
    detail: '远端 127.0.0.1:8901 已被占用',
    nextActions: ['改用其他端口重试（例如 8902）'],
    logTail: 'listen EADDRINUSE',
};
test('初始态停在第一个阶段、什么都没完成、不可取消', () => {
    const state = initialFlow();
    assert.equal(state.status, 'idle');
    assert.equal(state.phase, FLOW_PHASES[0]);
    assert.deepEqual(state.completed, []);
    assert.equal(canCancel(state), false);
    assert.equal(progressOf(state), 0);
});
test('阶段推进把上一个阶段记进 completed，进度随之增长', () => {
    let state = startFlow();
    assert.equal(canCancel(state), true);
    state = enterPhase(state, 'verify');
    assert.deepEqual(state.completed, ['probe']);
    assert.equal(state.phase, 'verify');
    state = enterPhase(state, 'launch');
    assert.deepEqual(state.completed, ['probe', 'verify']);
    assert.equal(progressOf(state), Math.round((2 / FLOW_PHASES.length) * 100));
});
test('允许跳阶段（reuse 档不需要 bootstrap），但绝不允许倒退', () => {
    const skipped = enterPhase(startFlow(), 'launch');
    assert.deepEqual(skipped.completed, ['probe']);
    assert.throws(() => enterPhase(skipped, 'probe'), /cannot move back from "launch" to "probe"/);
});
test('同一阶段重复进入是 no-op，不会把 completed 撑出重复项', () => {
    const once = enterPhase(startFlow(), 'verify');
    const twice = enterPhase(once, 'verify');
    assert.deepEqual(twice, once);
});
test('失败用错误自带的阶段覆盖当前阶段——错误发生的阶段才是真相', () => {
    const running = enterPhase(startFlow(), 'verify');
    const failed = failFlow(running, sampleError);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.phase, 'launch');
    assert.equal(failed.error?.code, 'remote/port-in-use');
    assert.equal(canCancel(failed), false);
});
test('终态之后再取消是 no-op——不能把 failed 改写成 cancelled', () => {
    const failed = failFlow(startFlow(), sampleError);
    const after = cancelFlow(failed);
    assert.equal(after.status, 'failed');
    assert.equal(after.error?.code, 'remote/port-in-use');
    const done = completeFlow(enterPhase(startFlow(), 'attach'));
    assert.equal(cancelFlow(done).status, 'done');
});
test('取消只对进行中有效，且保留已完成阶段', () => {
    const cancelled = cancelFlow(enterPhase(startFlow(), 'launch'));
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(cancelled.completed, ['probe']);
    assert.equal(cancelled.error, undefined);
    // 共享层只给结构化进度（文案在客户端字典）：`status` 才是断言对象。
    assert.equal(flowProgress(cancelled).status, 'cancelled');
});
test('完成收口把最后阶段也记进 completed', () => {
    const done = completeFlow(enterPhase(startFlow(), 'attach'));
    assert.equal(done.status, 'done');
    assert.deepEqual(done.completed, ['probe', 'attach']);
    assert.equal(progressOf(done), Math.round((2 / FLOW_PHASES.length) * 100));
    const progress = flowProgress(done);
    assert.equal(progress.status, 'done');
    assert.deepEqual([progress.completed, progress.total], [2, FLOW_PHASES.length]);
});
test('flowReport 四段齐全且可复制；日志尾为空时不产出空的 log 段', () => {
    const report = flowReport(failFlow(startFlow(), sampleError));
    assert.ok(report.includes('code: remote/port-in-use'));
    assert.ok(report.includes('phase: launch'));
    assert.ok(report.includes('detail: 远端 127.0.0.1:8901 已被占用'));
    assert.ok(report.includes('next: 改用其他端口重试'));
    assert.ok(report.includes('--- log ---'));
    const noLog = flowReport(failFlow(startFlow(), { ...sampleError, logTail: '' }));
    assert.ok(!noLog.includes('--- log ---'));
});
test('RemoteCrError 结构上满足 FlowError——宿主半可以把异常直接塞进状态', () => {
    const thrown = new RemoteCrError({
        code: 'remote/port-in-use',
        detail: '端口被占用',
        nextActions: ['换端口'],
        logTail: 'EADDRINUSE',
    });
    const asFlow = thrown;
    assert.equal(asFlow.phase, 'launch');
    assert.deepEqual(asFlow.nextActions, ['换端口']);
    const state = failFlow(startFlow(), asFlow);
    assert.equal(state.error?.code, 'remote/port-in-use');
});
test('NEGATIVE_CONTROL 可假性：把「取消覆盖失败」放回去必须让终态断言失败', () => {
    const failed = failFlow(startFlow(), sampleError);
    const mutated = { ...failed, status: 'cancelled', error: undefined };
    if (process.env.NEGATIVE_CONTROL === '1') {
        assert.equal(mutated.status, 'failed');
        return;
    }
    assert.notEqual(mutated.status, 'failed');
});
//# sourceMappingURL=flow.test.js.map