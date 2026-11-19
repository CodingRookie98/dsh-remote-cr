import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
/**
 * 客户端 target 接线的源码门禁（P4 A3-N5/M6）。
 *
 * 服务端早就接受 target 了，客户端却只接了 3/7 —— 把 `*Of` 删干净，客户端用例仍然全绿。
 * 这里钉住「每个写/读入口都按 focusTarget 分支」，真实行为仍靠 L4 与手工验收。
 */
const SOURCE = readFileSync('src/client/panel-view.ts', 'utf8');
test('会话 / 取证 / 导入 / 刷新 都必须按 focusTarget 分流', () => {
    for (const name of ['createSessionOf', 'probeRemoteSessionOf', 'listImportableOf', 'importWorkspacesOf', 'refreshProjectionOf', 'readProjectionOf']) {
        assert.match(SOURCE, new RegExp(name + '\\('), '缺少 ' + name + ' 的调用点（只加 API 不接线等于没做）');
    }
    assert.match(SOURCE, /refresh: \(\) => \(focusTarget === null \? refreshProjection\(\) : refreshProjectionOf\(focusTarget\)\)/);
    assert.match(SOURCE, /\[focusTarget\]/, 'runner 必须随 focusTarget 重建，否则切主机后仍读到旧那台');
});
//# sourceMappingURL=target-wiring.test.js.map