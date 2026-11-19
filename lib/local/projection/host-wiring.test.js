import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
/**
 * 生产装配的源码门禁（P4 A3-B1）。
 *
 * A1/A2/A3 的容器、端口、引用计数都有单测，但生产 `index.ts` 一度仍只建**一个** `ProjectionService`
 * 并只传 `projection` —— 容器变成「每台 target 指向同一个实例」，多 host 在生产里根本不成立。
 * 这类「实现了但没接线」的洞，只有盯装配点才能守住（与 `purge-wiring.test.ts` 同一套做法）。
 */
const SOURCE = readFileSync('src/index.ts', 'utf8');
test('生产装配必须是 ProjectionHub 工厂，而不是单个 ProjectionService', () => {
    assert.match(SOURCE, /new ProjectionHub\(/, '必须用容器工厂建服务（每 target 一个引擎）');
    assert.match(SOURCE, /registerRemoteCrRoutes\(ctx, \{\s*hub,/, '装配必须把 hub 传给路由');
    assert.equal(/registerRemoteCrRoutes\(ctx, \{\s*projection,/.test(SOURCE), false, '不许退回「只传 projection」——那会让容器退化成单服务适配器');
    assert.match(SOURCE, /hub\.disposeAll\(\)/, '卸载时必须级联 dispose 所有引擎');
});
//# sourceMappingURL=host-wiring.test.js.map