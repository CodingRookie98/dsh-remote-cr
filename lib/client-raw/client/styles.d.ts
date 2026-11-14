/**
 * 面板的**样式层**（浏览器半）。
 *
 * 设计方向（2026-11-14 重做）：**IDE 状态栏 + 数据网格**。
 * 面板不是一张表单，而是一个开发工具的仪表盘：顶部一条状态栏，下面三块数据区。
 *
 * 三条约束：
 * 1. **只改 CSS，不改 DOM** —— 40+ 个 `data-teleport` 选择器是探针的断言面，动结构就要重跑全部真机。
 * 2. **颜色全部走宿主令牌**（`--dsw-alias-*`）—— 面板必须跟着 DSH 的明暗主题自动切换，
 *    写死灰白会在深色主题里变成一块补丁。
 * 3. **区块标题用 ::before 生成** —— 加标题不该新增 DOM 节点。
 */
export declare const PANEL_STYLE_ATTR = "data-dsh-remote-cr-styles";
export declare const PANEL_CSS: string;
/** 幂等注入：多次挂载只留一份 `<style>`（DSH 的面板可能被反复卸载/挂载）。 */
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
export declare function ensurePanelStyles(host?: StyleHost | undefined): void;
