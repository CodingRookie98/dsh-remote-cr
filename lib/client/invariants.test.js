import assert from 'node:assert/strict';
import test from 'node:test';
import { initialWizard, reportOf } from "./state.js";
import { localizeFailure } from "./panel.js";
import { zh } from "./locales.js";
/**
 * L6「不变量」：这些用例不测某个功能，而是钉住**一类 bug 不许再出现**。
 *
 * 由来见 `docs/design/testing.md`：0.4.0 的八轮审查里，真正漏掉的缺陷没有一个是
 * 「某个函数算错了」，全是**连线**——夹具与线上形状脱节、用例走不到目标分支、门禁只看
 * 一半字段。所以下面三条针对的是「类」，不是「例」。
 */
test('L6-1 每条错误码都必须有下一步：66/66 全覆盖，新增码时漏写会红', () => {
    const codes = Object.keys(zh)
        .filter((key) => key.startsWith('err.'))
        .map((key) => key.slice('err.'.length));
    assert.ok(codes.length >= 60, '码表看起来不对：' + String(codes.length));
    const withNext = new Set(Object.keys(zh)
        .filter((key) => key.startsWith('errNext.'))
        .map((key) => key.slice('errNext.'.length).split('/')[0]));
    const missing = codes.filter((code) => !withNext.has(code.split('/')[0]));
    assert.deepEqual(missing, [], '这些码没有「下一步」：' + missing.join(', '));
});
test('L6-2 复制日志是纯函数：调用两次结果相同，且不修改输入（冻结后仍不抛）', () => {
    const state = initialWizard();
    const first = reportOf(state);
    const second = reportOf(state);
    assert.equal(first, second, '同样的状态两次渲染必须一致');
    // 深冻结：任何写入都会在严格模式下抛错，从而把「渲染顺手改了状态」抓出来。
    const frozen = deepFreeze(structuredClone({ ...state }));
    assert.doesNotThrow(() => reportOf(frozen));
});
test('L6-3 本地化永不产出空串或 undefined：未知码回落到宿主原文', () => {
    const known = localizeFailure({ code: 'remote/path-unreadable', detail: '宿主原文', nextActions: [] });
    assert.ok(known.detail.trim() !== '');
    const unknown = localizeFailure({ code: 'vendor/some-new-code', detail: '宿主原文', nextActions: [] });
    assert.equal(unknown.detail, '宿主原文', '认不出的码必须整条回落到宿主原文，不能印键名');
    assert.ok(!known.detail.includes('undefined'));
    assert.ok(!unknown.detail.includes('undefined'));
});
/** 深冻结（测试用；不引入依赖）。 */
function deepFreeze(value) {
    if (value !== null && typeof value === 'object') {
        for (const nested of Object.values(value))
            deepFreeze(nested);
        Object.freeze(value);
    }
    return value;
}
//# sourceMappingURL=invariants.test.js.map