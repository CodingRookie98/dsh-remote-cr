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
const DIALOG = readFileSync(join(process.cwd(), 'src/client/components.ts'), 'utf8');
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
/**
 * 远端没有 dsh 时，对话框必须**同时**给提示与禁用按钮（R1-B1 的可见面）。
 * 组件在 node 里跑不起来（react 是 peer，测试环境没有），所以这条只能做源码门禁——
 * 与上面两条同类：纯函数用例抓不到「渲染分支被删掉」。
 */
test('runtime 缺失时对话框渲染 sync-no-runtime 并禁用同步按钮', () => {
    assert.match(DIALOG, /syncBlockedReason\(state\.plan\)/, '必须真的用判定函数（不能只渲染一句静态文案）');
    assert.match(DIALOG, /'data-remote-cr': 'sync-no-runtime'/, '提示必须带可断言的标记（L4 场景 sync-no-runtime 依赖它）');
    assert.match(DIALOG, /disabled: state\.selected\.length === 0 \|\| blocked !== null/, '禁用位必须带上 blocked');
});
/**
 * 两条写路径的**界面侧**互斥（R2 放行验证的建议项）：服务端已有共享锁兜底，
 * 这里钉住「按钮也不该让人点」——否则用户点了才被拒，白等一轮。
 */
test('界面侧互斥：升级中禁用同步、同步中禁用升级', () => {
    assert.match(DIALOG, /disabled: state\.selected\.length === 0 \|\| blocked !== null \|\| upgrade\.phase === 'running'/, '升级在飞时同步按钮必须禁用');
    assert.match(DIALOG, /disabled: upgrade\.phase === 'running' \|\| state\.phase === 'applying'/, '同步在飞时对齐按钮必须禁用');
});
//# sourceMappingURL=sync-wiring.test.js.map