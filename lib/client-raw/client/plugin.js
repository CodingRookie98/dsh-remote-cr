"use strict";
/**
 * 浏览器半的 cordis 插件实现：注册 slot + 挂诊断面。
 *
 * 注册逻辑在 `registration.ts`（纯逻辑，可在 node 里断言）；本文件只做两件
 * 不能抽走的事：把**真实组件**交给它，以及把诊断面挂到 `globalThis`。
 *
 * 之所以要拆：组件 import `react`，而 `react` 由宿主模块表提供、本仓库没装，
 * 在 node 里 import 组件就会炸。拆开之后注册逻辑可测、组件不可测但可被 CDP 断言。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PANEL_ID = exports.inject = void 0;
exports.apply = apply;
const components_ts_1 = require("./components.js");
const panel_view_ts_1 = require("./panel-view.js");
const half_ts_1 = require("./half.js");
const i18n_ts_1 = require("./i18n.js");
const registration_ts_1 = require("./registration.js");
const styles_ts_1 = require("./styles.js");
const wizard_store_ts_1 = require("./wizard-store.js");
/** 依赖的宿主服务。`layout` 让面板进得了主区，`slots` 是注册入口。 */
exports.inject = ['slots', 'layout', 'locale'];
/** 面板与图标共用的 id/key；从 `registration.ts` 透出，保持单一来源。 */
var registration_ts_2 = require("./registration.js");
Object.defineProperty(exports, "PANEL_ID", { enumerable: true, get: function () { return registration_ts_2.PANEL_ID; } });
const IDLE_FLOW = { status: 'idle', phase: 'probe', completed: [], error: undefined };
function stringOption(options, name) {
    const value = options[name];
    return typeof value === 'string' ? value : null;
}
function apply(ctx) {
    // 字典先注册、再绑定：`bind` 只拿翻译函数，真正能翻出中文/英文靠的是这次注册。
    // 宿主没有 locale 服务时（老版本宿主）整块跳过，`t()` 自动回落 zh 字典。
    if (ctx.locale !== undefined) {
        const locale = ctx.locale;
        ctx.effect(() => (0, i18n_ts_1.registerDictionaries)(locale), 'dsh-remote-cr: locale dictionaries');
    }
    (0, i18n_ts_1.bindLocale)(ctx.locale);
    // 幂等：样式只挂一次；插槽没有给第三方 CSS 的入口，所以用 <style> + data-remote-cr 选择器。
    (0, styles_ts_1.ensurePanelStyles)();
    const mounted = (0, registration_ts_1.registerSlots)(ctx, {
        panel: panel_view_ts_1.RemoteCrPanel,
        icon: panel_view_ts_1.RemoteCrIcon,
        flow: components_ts_1.DirectoryFlow,
        // 会话行徽标：DSH 侧栏渲染时按 sessionId 注入 props（RFC-0003 R2-3）
        sessionBadge: components_ts_1.sessionBadge,
    });
    const diagnostics = {
        half: half_ts_1.HALF,
        describeSelf: (0, half_ts_1.describeSelf)(),
        mounted,
        entries: (name) => ctx.slots.entries(name).map((entry) => {
            const priority = entry.options['priority'];
            return {
                slot: name,
                priority: typeof priority === 'number' ? priority : 0,
                key: stringOption(entry.options, 'key'),
                id: stringOption(entry.options, 'id'),
            };
        }),
        flow: () => wizard_store_ts_1.wizardStore.get().flow?.state ?? IDLE_FLOW,
        report: () => {
            const state = wizard_store_ts_1.wizardStore.get();
            if (state.flow !== null)
                return state.flow.state.error?.detail ?? null;
            return state.sourcesError ?? state.listingError;
        },
    };
    globalThis.__REMOTE_CR__ = diagnostics;
}
