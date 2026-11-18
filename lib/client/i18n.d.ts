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
import { en, zh, type RemoteCrKey } from './locales.ts';
/** 本插件拥有的字典命名空间。 */
export declare const LOCALE_NAMESPACE = "remote-cr";
/** 只取文案需要的那一面（单测里常见，故意拆小）。 */
export interface LocaleBinder {
    bind(namespace: string): (key: string, params?: Record<string, unknown>) => string;
}
/** 宿主 locale 服务的完整最小面：注册字典 + 取翻译函数。 */
export interface LocaleFace extends LocaleBinder {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void;
}
/**
 * 绑定宿主 locale 服务。
 * @param face - 宿主 locale 服务；宿主没有该服务时传 undefined 即回落 zh。
 */
export declare function bindLocale(face: LocaleBinder | undefined): void;
/**
 * 取一条文案。
 * @param key - 字典键；缺失时依次回落 zh 字典与键本身（后者便于发现漏配）。
 * @returns 当前语言下的文案。
 */
export declare function t(key: RemoteCrKey, params?: Record<string, string | number>): string;
/**
 * 把两套字典注册进宿主 locale 服务。
 *
 * 只注册 zh + en：其余语言由宿主按 fallback 链回落到 en（宿主内置 8 种语言，
 * 我们不机翻）。返回 disposer，调用方负责在 `ctx.effect` 里收口。
 * @param face - 宿主 locale 服务。
 * @returns 注销函数。
 */
export declare function registerDictionaries(face: LocaleFace): () => void;
/** 清空绑定；只给测试用，避免用例之间互相污染。 */
export declare function resetLocaleBinding(): void;
export { en, zh, type RemoteCrKey };
//# sourceMappingURL=i18n.d.ts.map