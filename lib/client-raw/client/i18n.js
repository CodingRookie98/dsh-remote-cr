"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.zh = exports.en = exports.LOCALE_NAMESPACE = void 0;
exports.bindLocale = bindLocale;
exports.t = t;
exports.registerDictionaries = registerDictionaries;
exports.resetLocaleBinding = resetLocaleBinding;
/**
 * 宿主 locale 服务的最小接线（零 JSX 侧）。
 *
 * 三个约束，都来自宿主 `dsh-client-locale` 的实际行为：
 * 1. `bind(ns)` 返回**稳定函数**并**在调用时**读当前语言——所以只需绑定一次，
 *    语言切换后不必重新绑定；
 * 2. 文案随 slot 重渲染更新（宿主在 locale 变化时推进 revision 并通知渲染），
 *    我们不需要自己订阅；
 * 3. 没有 locale 服务时（node 单测、宿主未挂载该包）**回落到 zh**，绝不把 key
 *    直接印到界面上。
 *
 * @module dsh-remote-cr/client/i18n
 */
const locales_ts_1 = require("./locales.js");
Object.defineProperty(exports, "en", { enumerable: true, get: function () { return locales_ts_1.en; } });
Object.defineProperty(exports, "zh", { enumerable: true, get: function () { return locales_ts_1.zh; } });
/** 本插件拥有的字典命名空间。 */
exports.LOCALE_NAMESPACE = 'remote-cr';
/** 已绑定的翻译函数；undefined 表示还没绑定（走 zh 回落）。 */
let translate;
/**
 * 绑定宿主 locale 服务。
 * @param face - 宿主 locale 服务；宿主没有该服务时传 undefined 即回落 zh。
 */
function bindLocale(face) {
    translate = face === undefined ? undefined : (key, params) => face.bind(exports.LOCALE_NAMESPACE)(key, params);
}
/**
 * 取一条文案。
 * @param key - 字典键；缺失时依次回落 zh 字典与键本身（后者便于发现漏配）。
 * @returns 当前语言下的文案。
 */
function t(key, params) {
    const bound = params === undefined ? translate?.(key) : translate?.(key, params);
    if (bound !== undefined && bound !== '')
        return bound;
    return fill(locales_ts_1.zh[key] ?? key, params);
}
/**
 * 回落路径上的 `{name}` 替换：与宿主 `translate` 同一个插值约定，
 * 保证「没有宿主」与「有宿主」两种情况的文案形状一致。
 * @param template - 含 `{name}` 占位符的模板。
 * @param params - 替换值；缺失的占位符原样保留（便于发现漏传）。
 * @returns 填好的文案。
 */
function fill(template, params) {
    if (params === undefined)
        return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}
/**
 * 把两套字典注册进宿主 locale 服务。
 *
 * 只注册 zh + en：其余语言由宿主按 fallback 链回落到 en（宿主内置 8 种语言，
 * 我们不机翻）。返回 disposer，调用方负责在 `ctx.effect` 里收口。
 * @param face - 宿主 locale 服务。
 * @returns 注销函数。
 */
function registerDictionaries(face) {
    return face.register(exports.LOCALE_NAMESPACE, { zh: locales_ts_1.zh, en: locales_ts_1.en });
}
/** 清空绑定；只给测试用，避免用例之间互相污染。 */
function resetLocaleBinding() {
    translate = undefined;
}
