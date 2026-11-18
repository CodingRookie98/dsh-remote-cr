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
/** 一个可注册的 slot 洞。 */
export interface SlotRegistration {
    readonly name: string;
    readonly priority?: number;
    readonly key?: string;
    readonly id?: string;
    readonly order?: number;
    readonly label?: () => string;
    /** 额外塞给组件的 props（与 owner props、标准 kit 摊平成一个对象）。 */
    readonly inject?: () => Record<string, unknown>;
}
/** 我们依赖的宿主 slots 服务的最小面（只写真正调用的两个方法）。 */
export interface SlotRegistry {
    inject(name: string, execute: () => unknown): unknown;
    register(options: SlotRegistration, component: unknown): unknown;
}
export interface RegistrationContext {
    readonly slots: SlotRegistry;
    effect(execute: () => () => void, label: string): unknown;
}
/** 三个要被挂上去的组件。 */
export interface RemoteCrComponents {
    readonly panel: unknown;
    readonly icon: unknown;
    readonly flow: unknown;
    /** 会话行「远端」徽标（RFC-0003 R2-3）。 */
    readonly sessionBadge: unknown;
}
/** 面板与图标共用的 id/key；两者必须一致，否则侧栏点了没反应（M0 实测 V2）。 */
export declare const PANEL_ID = "remote-cr";
/** 侧栏顺序：排在官方面板之后，但比其他插件靠前。 */
export declare const PANEL_ORDER = 20;
/** 我们抢占的两个 directoryFlow 洞（`ui-design.md` §4）。 */
export declare const DIRECTORY_FLOW_SLOTS: readonly ["conversation.hero.workspace.directoryFlow", "sidebar.workspaces.directoryFlow"];
/**
 * 把三个组件挂到四个洞上，返回「当前还挂着的洞名」的可变数组。
 *
 * 两个 directoryFlow 洞用 generator **一次性注册**（官方 `ui-directory-picker-browse`
 * 的写法）：任一注册失败就整体回滚，不会出现「侧栏抢到了、hero 没抢到」的半截状态。
 *
 * 三处注册都包在 `ctx.effect` 里：插件卸载时 slot 必须跟着摘掉，否则重新加载会撞
 * `duplicate`，或者留下一个点不动的按钮。
 */
export declare function registerSlots(ctx: RegistrationContext, components: RemoteCrComponents): string[];
//# sourceMappingURL=registration.d.ts.map