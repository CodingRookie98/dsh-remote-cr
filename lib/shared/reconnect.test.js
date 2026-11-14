import assert from 'node:assert/strict';
import test from 'node:test';
import { OFFLINE_RETRY_MS, RECONNECT_ROUNDS, RECONNECT_STEPS_MS, ReconnectDriver, afterConnected, afterManualReconnect, describeReconnect, initialReconnectState, planRetry, } from "./reconnect.js";
/** 假定时器：只记账，不真的睡；由测试手动推进。 */
function fakeTimers() {
    const entries = [];
    return {
        schedule(delayMs, run) {
            entries.push({ delayMs, run });
            return entries.length - 1;
        },
        cancel(handle) {
            const index = handle;
            if (entries[index] !== undefined)
                entries[index] = { delayMs: Number.NaN, run: () => { } };
        },
        pending() {
            return entries.filter((entry) => !Number.isNaN(entry.delayMs)).map((entry) => entry.delayMs);
        },
        async flush() {
            let next = entries.shift();
            while (next !== undefined && Number.isNaN(next.delayMs))
                next = entries.shift();
            if (next === undefined)
                return;
            next.run();
            // 让 #fire 里的 promise 链跑完
            await new Promise((resolve) => setImmediate(resolve));
        },
    };
}
test('前三档间隔是 2s / 4s / 8s，符合 requirements §7 的规格', () => {
    assert.deepEqual([...RECONNECT_STEPS_MS], [2000, 4000, 8000]);
});
test('连续排九次重试正好走三轮 2/4/8，第十次起转 offline 并按 2 分钟一次', () => {
    let state = initialReconnectState();
    const fast = [];
    for (let i = 0; i < RECONNECT_STEPS_MS.length * RECONNECT_ROUNDS; i += 1) {
        const planned = planRetry(state);
        fast.push(planned.delayMs);
        state = planned.next;
        assert.equal(state.phase, 'retrying', `第 ${i + 1} 次仍应在快速档`);
    }
    assert.deepEqual(fast, [2000, 4000, 8000, 2000, 4000, 8000, 2000, 4000, 8000]);
    const offline = planRetry(state);
    assert.equal(offline.delayMs, OFFLINE_RETRY_MS);
    assert.equal(offline.next.phase, 'offline');
    // 进入 offline 后一直保持，不会自己回到快速档
    const again = planRetry(offline.next);
    assert.equal(again.delayMs, OFFLINE_RETRY_MS);
    assert.equal(again.next.phase, 'offline');
});
test('连上（settle）与手动重连都把计数器打回 0，三段退避从头开始', () => {
    assert.deepEqual(afterConnected(), { attempt: 0, phase: 'retrying' });
    assert.deepEqual(afterManualReconnect(), { attempt: 0, phase: 'retrying' });
    // 打回之后第一次又该是 2s，而不是接着 8s 往上爬
    assert.equal(planRetry(afterManualReconnect()).delayMs, 2000);
});
test('describeReconnect 在两种相位下都可 grep 且带上档位信息', () => {
    assert.equal(describeReconnect({ attempt: 0, phase: 'retrying' }), 'reconnect retrying (attempt 0, steps 2000/4000/8000ms ×3)');
    assert.equal(describeReconnect({ attempt: 9, phase: 'offline' }), 'reconnect offline (attempt 9, every 120000ms)');
});
test('Driver：失败自动排下一档，成功即停；手动重连立刻试一次并归零', async () => {
    const timers = fakeTimers();
    const scheduled = [];
    let outcome = 'fail';
    let calls = 0;
    const driver = new ReconnectDriver({
        attempt: async () => {
            calls += 1;
            if (outcome === 'fail')
                throw new Error('still down');
        },
        timers,
        onSchedule: (delayMs) => scheduled.push(delayMs),
    });
    driver.start();
    assert.deepEqual(scheduled, [2000]);
    assert.equal(driver.state.attempt, 1, 'start() 排下第一次重试，attempt 从 0 走到 1');
    await timers.flush(); // 第一次尝试失败 → 排 4000
    assert.equal(calls, 1);
    assert.deepEqual(scheduled, [2000, 4000]);
    assert.equal(driver.state.attempt, 2, '失败一次后 attempt 应为 2（已排两次）');
    outcome = 'ok';
    await timers.flush(); // 第二次尝试成功 → settle，不再排
    assert.equal(calls, 2);
    assert.deepEqual(scheduled, [2000, 4000]);
    assert.deepEqual(driver.state, { attempt: 0, phase: 'retrying' });
    // 再次断线：从头 2s（此时让远端仍然连不上，才能观察到 attempt 递增）
    outcome = 'fail';
    driver.start();
    assert.deepEqual(scheduled.slice(-1), [2000], '重连成功后再次断线，第一次重试又该是 2s');
    assert.equal(driver.state.attempt, 1);
    driver.reconnectNow();
    await new Promise((resolve) => setImmediate(resolve));
    // 手动重连 = 立刻试一次；这次仍失败则按「从头」的 2s 排下一次，
    // 而不是接着之前的 4000ms 往上爬（T6-4d 实测的就是这个语义）。
    assert.deepEqual(scheduled.slice(-1), [2000], '手动重连后第一次重试必须回到 2s');
    assert.equal(driver.state.attempt, 1);
    driver.dispose();
});
test('NEGATIVE_CONTROL 可假性：把三档改成官方内核的 500ms×2 必须让「2s 起步」的断言失败', () => {
    const productSteps = [2000, 4000, 8000];
    const kernelSteps = [500, 1000, 2000];
    if (process.env.NEGATIVE_CONTROL === '1') {
        assert.equal(planRetry({ attempt: 0, phase: 'retrying' }).delayMs, kernelSteps[0]);
        return;
    }
    assert.equal(planRetry({ attempt: 0, phase: 'retrying' }).delayMs, productSteps[0]);
    assert.notEqual(planRetry({ attempt: 0, phase: 'retrying' }).delayMs, kernelSteps[0]);
});
//# sourceMappingURL=reconnect.test.js.map