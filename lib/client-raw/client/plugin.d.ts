/**
 * 浏览器半的 cordis 插件实现：注册 slot + 挂诊断面。
 *
 * 注册逻辑在 `registration.ts`（纯逻辑，可在 node 里断言）；本文件只做两件
 * 不能抽走的事：把**真实组件**交给它，以及把诊断面挂到 `globalThis`。
 *
 * 之所以要拆：组件 import `react`，而 `react` 由宿主模块表提供、本仓库没装，
 * 在 node 里 import 组件就会炸。拆开之后注册逻辑可测、组件不可测但可被 CDP 断言。
 */
import { type RegistrationContext } from './registration.ts';
/** 依赖的宿主服务。`layout` 让面板进得了主区，`slots` 是注册入口。 */
export declare const inject: readonly ["slots", "layout"];
/** 面板与图标共用的 id/key；从 `registration.ts` 透出，保持单一来源。 */
export { PANEL_ID } from './registration.ts';
interface DiagnosticSlots {
    entries(name: string): readonly {
        options: Record<string, unknown>;
    }[];
}
type ClientContext = RegistrationContext & {
    readonly slots: RegistrationContext['slots'] & DiagnosticSlots;
};
export declare function apply(ctx: ClientContext): void;
