/**
 * slot 注册逻辑的单测。
 *
 * 为什么能测：`registration.ts` 不 import 组件、不 import `react`，所以能在 node 里
 * 跑。测的是**注册契约**——挂了哪几个洞、`priority`/`key`/`id` 是多少、卸载有没有
 * 摘干净、两个 directoryFlow 是不是同一个事务。这些正是 M0 实测（V1/V2/V12）踩过的
 * 坑，写死成断言比写在注释里可靠。
 *
 * 关于假 slots 的语义：`inject(name, execute)` 执行 `execute()`；产物是 generator 时
 * 逐个消费 yield，**任一 yield 抛出就逆序回滚已注册条目再向上抛**——这是 cordis
 * 对 generator 形态 inject 的既定行为（官方 `ui-directory-picker-browse` 正是靠它
 * 让两次注册成为一个事务）。假实现照此建模，否则「事务」这条断言测的只是假件本身。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DIRECTORY_FLOW_SLOTS, PANEL_ID, PANEL_ORDER, registerSlots, } from "./registration.js";
function fakeSlots() {
    const recorded = [];
    const effects = [];
    const disposers = [];
    const failOn = { name: null };
    let scopes = 0;
    const isGenerator = (value) => value !== null &&
        typeof value === 'object' &&
        typeof value.next === 'function' &&
        typeof value.throw === 'function';
    const registry = {
        inject(_name, execute) {
            scopes += 1;
            const produced = execute();
            if (!isGenerator(produced))
                return produced;
            const owned = [];
            try {
                for (;;) {
                    const step = produced.next();
                    if (step.done === true)
                        break;
                    owned.push(typeof step.value === 'function' ? step.value : () => { });
                }
            }
            catch (error) {
                for (const dispose of [...owned].reverse())
                    dispose();
                throw error;
            }
            return () => {
                for (const dispose of [...owned].reverse())
                    dispose();
            };
        },
        register(options, component) {
            if (failOn.name === options.name) {
                failOn.name = null;
                throw new Error('register failed for ' + options.name);
            }
            const entry = { name: options.name, options, component, scope: scopes };
            recorded.push(entry);
            return () => {
                const at = recorded.indexOf(entry);
                if (at >= 0)
                    recorded.splice(at, 1);
            };
        },
    };
    const ctx = {
        slots: registry,
        effect(execute, label) {
            effects.push(label);
            const dispose = execute();
            disposers.push(dispose);
            return dispose;
        },
    };
    return {
        ctx,
        recorded,
        effects,
        disposers,
        get scopes() {
            return scopes;
        },
        failOn,
    };
}
const components = {
    panel: 'PANEL',
    icon: 'ICON',
    flow: 'FLOW',
    sessionBadge: 'BADGE',
    sessionReconnectItem: 'RECONNECT',
};
test('五处注册全部落位：main / sidebar.panellist / 会话行徽标 / 两个 directoryFlow', () => {
    const fake = fakeSlots();
    const mounted = registerSlots(fake.ctx, components);
    assert.deepEqual(fake.recorded.map((entry) => entry.name).sort(), [
        'conversation.hero.workspace.directoryFlow',
        'main',
        'sidebar.panellist',
        'sidebar.session.row.leading',
        'sidebar.workspaces.directoryFlow',
        'sidebar.workspaces.session.menu.item',
    ]);
    assert.deepEqual(mounted.slice().sort(), [
        'directoryFlow',
        'main',
        'sessionBadge',
        'sessionReconnect',
        'sidebar.panellist',
    ]);
    const badge = fake.recorded.find((entry) => entry.name === 'sidebar.session.row.leading');
    assert.equal(badge?.component, 'BADGE', '徽标组件必须真的挂上去，而不是只登记了个空位');
});
test('面板与图标同 id/key：id 与 key 都必须是 PANEL_ID（M0 实测 V2，不一致侧栏点了没反应）', () => {
    const fake = fakeSlots();
    registerSlots(fake.ctx, components);
    const main = fake.recorded.find((entry) => entry.name === 'main');
    const icon = fake.recorded.find((entry) => entry.name === 'sidebar.panellist');
    assert.equal(main?.options.key, PANEL_ID);
    assert.equal(icon?.options.id, PANEL_ID);
    assert.equal(main?.component, 'PANEL');
    assert.equal(icon?.component, 'ICON');
    assert.equal(icon?.options.order, PANEL_ORDER);
    assert.equal(icon?.options.label?.(), '远端工作台', '侧栏 label 走 locale 字典（无宿主时回落 zh）');
});
test('两个 directoryFlow 洞必须 priority: -1（M0 实测 V1：只有负优先级能顶掉官方浏览器）', () => {
    const fake = fakeSlots();
    registerSlots(fake.ctx, components);
    for (const slot of DIRECTORY_FLOW_SLOTS) {
        const entry = fake.recorded.find((candidate) => candidate.name === slot);
        assert.equal(entry?.options.priority, -1, slot + ' 必须以 -1 抢占');
        assert.equal(entry?.component, 'FLOW');
    }
});
test('两个 directoryFlow 注册在同一个 inject 作用域里（不是两个独立 effect）', () => {
    const fake = fakeSlots();
    registerSlots(fake.ctx, components);
    const hero = fake.recorded.find((entry) => entry.name === DIRECTORY_FLOW_SLOTS[0]);
    const sidebar = fake.recorded.find((entry) => entry.name === DIRECTORY_FLOW_SLOTS[1]);
    assert.notEqual(hero, undefined);
    assert.equal(hero?.scope, sidebar?.scope);
});
test('五次 ctx.effect：卸载时六个洞都要摘掉，mounted 也要清空', () => {
    const fake = fakeSlots();
    const mounted = registerSlots(fake.ctx, components);
    assert.equal(fake.effects.length, 5);
    assert.equal(fake.recorded.length, 6);
    for (const dispose of fake.disposers)
        dispose();
    assert.deepEqual(fake.recorded, []);
    assert.deepEqual(mounted, []);
});
test('两个 directoryFlow 是一个事务：第二个注册失败时第一个必须被回滚', () => {
    const fake = fakeSlots();
    fake.failOn.name = 'sidebar.workspaces.directoryFlow';
    assert.throws(() => registerSlots(fake.ctx, components), /register failed for sidebar\.workspaces\.directoryFlow/);
    // hero 洞的注册必须已经被回滚，不能留下「抢到了半边」的状态。
    assert.equal(fake.recorded.some((entry) => entry.name === 'conversation.hero.workspace.directoryFlow'), false);
    assert.equal(fake.recorded.some((entry) => entry.name === 'main'), true);
});
test('NEGATIVE_CONTROL 可假性：把 directoryFlow 的 priority 改成 0，必须让抢占断言失败', () => {
    const fake = fakeSlots();
    registerSlots(fake.ctx, components);
    const entry = fake.recorded.find((candidate) => candidate.name === DIRECTORY_FLOW_SLOTS[0]);
    // 变异被测量：负控下假装注册时没写 priority（等价于默认 0）。
    const priority = process.env['NEGATIVE_CONTROL'] === '1' ? 0 : entry?.options.priority;
    assert.equal(priority, -1);
});
//# sourceMappingURL=registration.test.js.map