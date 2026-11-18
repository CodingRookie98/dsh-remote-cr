import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
/**
 * 接线门禁（审查 N1：删掉两处自动提醒调用后 100 条客户端用例全绿）。
 *
 * 这类「调用点消失」的回归，纯函数用例永远抓不到 —— 用源码级断言钉住：
 *   1. 两处接入成功后各调一次 `openSyncDialog(true, syncTargetOf(…))`（目标必须来自接入入参）；
 *   2. 手动入口用 `openSyncDialog(false)`。
 */
const SOURCE = readFileSync(join(process.cwd(), 'src/client/panel-view.ts'), 'utf8');
/**
 * 语义位置断言：调用必须落在**接入成功之后、catch 之前**。
 * 只数次数是不够的——把它挪进 catch 里次数不变，但行为完全错了（delta-r1-2 的 P1 探针）。
 */
function attachBody(name) {
    const start = SOURCE.indexOf('const ' + name + ' = async');
    assert.notEqual(start, -1, name + ' 必须存在');
    const rest = SOURCE.slice(start);
    const end = rest.indexOf('catch (caught)');
    assert.notEqual(end, -1, name + ' 必须有 catch 块');
    return rest.slice(0, end);
}
test('自动提醒接在「接入成功之后、catch 之前」，且目标取自本次接入入参', () => {
    for (const name of ['onAttach', 'onSshAttach']) {
        assert.match(attachBody(name), /openSyncDialog\(true, syncTargetOf\(plan\.input\.target\)\)/, name + ' 的成功路径里必须有自动提醒（挪进 catch 或删掉都算错）');
    }
});
test('手动入口存在且用 auto=false', () => {
    assert.match(SOURCE, /openSyncDialog\(false\)/);
});
//# sourceMappingURL=sync-wiring.test.js.map