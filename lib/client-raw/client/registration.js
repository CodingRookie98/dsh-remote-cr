"use strict";
/**
 * slot 注册的**纯逻辑**（不 import 任何组件、不 import react）。
 *
 * 为什么从 `plugin.ts` 拆出来：`plugin.ts` 必须 import 组件，而组件 import `react`
 * ——`react` 由宿主模块表提供，本仓库没装，所以在 node 里 import 它就炸。把注册逻辑
 * 抽成「接收组件作为参数」的函数后，它就能在 `node --test` 里被完整断言（谁注册了
 * 什么、`priority` 是多少、卸载时有没有摘干净），而不需要伪造一个 React 运行时。
 *
 * 纪律：本文件只做「把组件挂到洞上」，不碰业务状态。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DIRECTORY_FLOW_SLOTS = exports.PANEL_ORDER = exports.PANEL_ID = void 0;
exports.registerSlots = registerSlots;
const i18n_ts_1 = require("./i18n.js");
/** 面板与图标共用的 id/key；两者必须一致，否则侧栏点了没反应（M0 实测 V2）。 */
exports.PANEL_ID = 'remote-cr';
/** 侧栏顺序：排在官方面板之后，但比其他插件靠前。 */
exports.PANEL_ORDER = 20;
/** 我们抢占的两个 directoryFlow 洞（`ui-design.md` §4）。 */
exports.DIRECTORY_FLOW_SLOTS = [
    'conversation.hero.workspace.directoryFlow',
    'sidebar.workspaces.directoryFlow',
];
/**
 * 把三个组件挂到四个洞上，返回「当前还挂着的洞名」的可变数组。
 *
 * 两个 directoryFlow 洞用 generator **一次性注册**（官方 `ui-directory-picker-browse`
 * 的写法）：任一注册失败就整体回滚，不会出现「侧栏抢到了、hero 没抢到」的半截状态。
 *
 * 三处注册都包在 `ctx.effect` 里：插件卸载时 slot 必须跟着摘掉，否则重新加载会撞
 * `duplicate`，或者留下一个点不动的按钮。
 */
function registerSlots(ctx, components) {
    const mounted = [];
    const track = (name, dispose) => {
        mounted.push(name);
        return () => {
            const at = mounted.indexOf(name);
            if (at >= 0)
                mounted.splice(at, 1);
            dispose();
        };
    };
    const own = (execute) => {
        const dispose = execute();
        return typeof dispose === 'function' ? dispose : () => { };
    };
    ctx.effect(() => track('main', own(() => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: exports.PANEL_ID, inject: () => ({}) }, components.panel)))), 'dsh-remote-cr: main panel');
    ctx.effect(() => track('sidebar.panellist', own(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: exports.PANEL_ID, order: exports.PANEL_ORDER, label: () => (0, i18n_ts_1.t)('panel.title') }, components.icon)))), 'dsh-remote-cr: panellist icon');
    // 会话行徽标：挂在 DSH 侧栏会话行的 leading 洞里（props 只有 sessionId）。
    // 与面板共用 remoteSessionIndex，因此面板没打开时也能认得出远端会话。
    ctx.effect(() => track('sessionBadge', own(() => ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({ name: 'sidebar.session.row.leading', id: 'remote-cr-badge', order: 10, inject: () => ({}) }, components.sessionBadge)))), 'dsh-remote-cr: session row badge');
    const [hero, sidebar] = exports.DIRECTORY_FLOW_SLOTS;
    ctx.effect(() => track('directoryFlow', own(() => ctx.slots.inject(hero, () => ctx.slots.inject(sidebar, function* () {
        yield ctx.slots.register({ name: hero, priority: -1, inject: () => ({}) }, components.flow);
        yield ctx.slots.register({ name: sidebar, priority: -1, inject: () => ({}) }, components.flow);
    })))), 'dsh-remote-cr: directory flow takeover');
    return mounted;
}
