/**
 * 面板的**样式层**（浏览器半）。
 *
 * 为什么单独一层而不是往每个 `h()` 里塞 style：面板有 40+ 个 `data-teleport` 节点，
 * 内联样式会散成 40 份互不相干的魔数；而 DSH 的插槽没有给第三方 CSS 的正式入口。
 * 所以用一次 `<style>` 注入 + `[data-teleport='…']` 选择器：结构仍是可断言的 DOM，
 * 视觉集中在一个文件里，改版只动这里。
 *
 * 选择器刻意只挂在面板根节点之下（`[data-teleport='panel'] …`），不去污染宿主样式。
 */
export declare const PANEL_STYLE_ATTR = "data-dsh-remote-cr-styles";
export declare const PANEL_CSS: string;
/**
 * 注入所需的 DOM 最小面。
 *
 * 不直接用 `Document` / `document`：本文件同时被宿主 tsc（无 DOM lib）编译，
 * 直接引用会让 `pnpm build` 报 TS2304。这里只声明真正用到的三个成员。
 */
export interface StyleHost {
    querySelector(selector: string): unknown;
    createElement(tag: string): {
        setAttribute(name: string, value: string): void;
        textContent: string;
    };
    readonly head: {
        appendChild(node: unknown): void;
    };
}
/** 幂等注入：多次挂载只留一份 `<style>`（DSH 的面板可能被反复卸载/挂载）。 */
export declare function ensurePanelStyles(host?: StyleHost | undefined): void;
