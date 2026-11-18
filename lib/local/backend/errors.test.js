import assert from 'node:assert/strict';
import test from 'node:test';
import { CONNECTION_PHASES, ERROR_PHASE, RemoteCrError, portInUseError } from "./errors.js";
test('阶段顺序就是 UI 进度条顺序，且至少覆盖探测到挂载', () => {
    assert.deepEqual([...CONNECTION_PHASES], ['probe', 'bootstrap', 'verify', 'launch', 'tunnel', 'barrier', 'attach']);
});
test('每个错误码都映射到 CONNECTION_PHASES 里的真实阶段（防止写了码忘了分批）', () => {
    for (const [code, phase] of Object.entries(ERROR_PHASE)) {
        assert.ok(CONNECTION_PHASES.includes(phase), `${code} 映射到了未知阶段 ${phase}`);
    }
});
test('端口占用是三选项 + 阶段 launch，符合 B3「不静默接管、不杀进程」', () => {
    const error = portInUseError(8899, 'listen EADDRINUSE: address already in use 127.0.0.1:8899');
    assert.equal(error.code, 'remote/port-in-use');
    assert.equal(error.phase, 'launch');
    assert.equal(error.nextActions.length, 3);
    assert.match(error.nextActions[0] ?? '', /复用/);
    assert.match(error.nextActions[1] ?? '', /8900/);
    assert.match(error.nextActions[2] ?? '', /关闭/);
    // 报告里必须带得走实测到的端口与日志
    const report = error.toReport();
    assert.match(report, /code: remote\/port-in-use/);
    assert.match(report, /127\.0\.0\.1:8899/);
    assert.match(report, /EADDRINUSE/);
});
test('未知码不抛、兜底到 probe 阶段，但 nextActions 绝不为空（铁律 4 的可重试路径）', () => {
    const error = new RemoteCrError({ code: 'remote/some-new-code', detail: 'something broke', nextActions: [] });
    assert.equal(error.phase, 'probe');
    assert.deepEqual([...error.nextActions], ['重试']);
});
test('cause 只在传了的时候挂上，不塞 undefined 污染 stack', () => {
    const withCause = new RemoteCrError({ code: 'remote/unknown', detail: 'x', nextActions: ['重试'], cause: new Error('inner') });
    assert.equal(withCause.cause.message, 'inner');
    const without = new RemoteCrError({ code: 'remote/unknown', detail: 'x', nextActions: ['重试'] });
    assert.equal(without.cause, undefined);
});
test('NEGATIVE_CONTROL 可假性：把端口占用降级成「静默接管」必须让三选项断言失败', () => {
    const silent = { code: 'remote/port-in-use', nextActions: ['已自动复用已有实例'] };
    if (process.env.NEGATIVE_CONTROL === '1') {
        assert.equal(portInUseError(8899).nextActions.length, silent.nextActions.length);
        return;
    }
    assert.notEqual(portInUseError(8899).nextActions.length, silent.nextActions.length);
});
//# sourceMappingURL=errors.test.js.map