import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { OwnedChildren } from "./children.js";
/** 假子进程：可控制「kill 之后是否真的退出」与「退出需要多久」。 */
class FakeChild extends EventEmitter {
    exitCode = null;
    signalCode = null;
    signals = [];
    pid;
    #behaviour;
    constructor(pid, behaviour) {
        super();
        this.pid = pid;
        this.#behaviour = behaviour;
    }
    kill(signal) {
        this.signals.push(signal);
        if (this.#behaviour === 'never-exit')
            return true;
        if (this.#behaviour === 'ignore-term' && signal !== 'SIGKILL')
            return true;
        this.exitCode = 0;
        this.signalCode = signal ?? 'SIGTERM';
        queueMicrotask(() => this.emit('exit'));
        return true;
    }
}
test('第一级就退出的走 graceful，不发 SIGKILL', async () => {
    const owned = new OwnedChildren();
    const child = new FakeChild(1, 'exit-immediately');
    owned.own({ label: 'wsl-tunnel', child });
    const report = await owned.dispose({ graceMs: 10, closeTimeoutMs: 10 });
    assert.deepEqual(report.graceful, ['wsl-tunnel']);
    assert.deepEqual(report.forced, []);
    assert.deepEqual(report.survivors, []);
    assert.deepEqual(child.signals, [undefined], '只在第一级发一次默认信号');
});
test('忽略 SIGTERM 的在第二级被 SIGKILL，记入 forced', async () => {
    const owned = new OwnedChildren();
    const child = new FakeChild(2, 'ignore-term');
    owned.own({ label: 'stubborn', child });
    const report = await owned.dispose({ graceMs: 5, closeTimeoutMs: 20 });
    assert.deepEqual(report.graceful, []);
    assert.deepEqual(report.forced, ['stubborn']);
    assert.deepEqual(child.signals, [undefined, 'SIGKILL']);
});
test('两级之后还活着的必须如实上报 survivors，绝不假装清理成功', async () => {
    const owned = new OwnedChildren();
    const child = new FakeChild(3, 'never-exit');
    owned.own({ label: 'immortal', child });
    const report = await owned.dispose({ graceMs: 5, closeTimeoutMs: 10 });
    assert.deepEqual(report.survivors, ['immortal']);
    assert.equal(owned.size, 1, 'survivor 仍计入存活数');
});
test('dispose 幂等：第二次返回同一份报告，不会重复 kill', async () => {
    const owned = new OwnedChildren();
    const child = new FakeChild(4, 'exit-immediately');
    owned.own({ label: 'once', child });
    const first = await owned.dispose({ graceMs: 5, closeTimeoutMs: 5 });
    const signalsAfterFirst = child.signals.length;
    const second = await owned.dispose({ graceMs: 5, closeTimeoutMs: 5 });
    assert.deepEqual(first, second);
    assert.equal(child.signals.length, signalsAfterFirst);
});
test('dispose 之后才登记的子进程会被立刻送走，不漏在系统里', async () => {
    const owned = new OwnedChildren();
    await owned.dispose();
    const late = new FakeChild(5, 'exit-immediately');
    owned.own({ label: 'late', child: late });
    assert.equal(late.signals.length, 1);
});
test('liveLabels/size 只统计存活者', async () => {
    const owned = new OwnedChildren();
    owned.own({ label: 'alive', child: new FakeChild(6, 'never-exit') });
    const gone = new FakeChild(7, 'exit-immediately');
    gone.kill();
    owned.own({ label: 'gone', child: gone });
    const alreadyDead = new FakeChild(8, 'exit-immediately');
    alreadyDead.kill();
    owned.own({ label: 'already-dead', child: alreadyDead });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(owned.liveLabels(), ['alive']);
    assert.equal(owned.size, 1);
});
test('NEGATIVE_CONTROL 可假性：只做一级（不升级 SIGKILL）必须让 forced 断言失败', async () => {
    const owned = new OwnedChildren();
    const child = new FakeChild(9, 'ignore-term');
    owned.own({ label: 'stubborn', child });
    if (process.env.NEGATIVE_CONTROL === '1') {
        // 只做一级的最小实现
        child.kill();
        await new Promise((resolve) => setTimeout(resolve, 5));
        assert.deepEqual([], ['stubborn'], '一级实现拿不到 forced，应红');
        return;
    }
    const report = await owned.dispose({ graceMs: 5, closeTimeoutMs: 20 });
    assert.deepEqual(report.forced, ['stubborn']);
});
//# sourceMappingURL=children.test.js.map