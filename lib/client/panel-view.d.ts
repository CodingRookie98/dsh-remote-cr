/**
 * 「远端工作台」面板（`main` 槽里的仪表盘）。
 *
 * 为什么从 components.ts 拆出来：那个文件已经 1800 行，而面板与向导是两个**独立的渲染根**
 * ——它们没有共享状态、没有互相引用，只共享「怎么把 store 里的状态读进组件」这几个小工具。
 * 拆开后各自一个文件，改面板不会让向导的 diff 变脏（R2-D12）。
 *
 * 依赖方向是单向的：本文件从 `components.ts` 取 `useWizard` / `update` / `copyText` / `messageOf`，
 * 反过来不成立（`components.ts` 不 import 本文件）。宿主的注册在 `plugin.ts` 里各取所需。
 */
import type { WorkspaceRecord } from '../shared/api.ts';
/**
 * 面板上的失败：结构化错误码 + 可复制报告 + 可重放动作（A8）。
 */
export interface PanelFailure {
    readonly code: string;
    readonly detail: string;
    readonly nextActions: readonly string[];
    readonly report: string;
    /**
     * 这次失败能用哪个动作重放。
     *
     * 与失败**一起**存，而不是另开一个 ref：读取类失败没有可重放的动作，若把「上一次写动作
     * 的意图」留在旁边，点「重试」就会再跑一次接入 / 再建一个会话（R1-M-3）。
     */
    readonly intent?: RetryIntent;
}
/** 侧栏图标：与 `main` 面板同 id/key 配对（M0 实测 V2，缺一个另一个就不显示）。 */
export declare function RemoteCrIcon(): unknown;
/**
 * 主面板：向导进度 + 已添加的目录 + 已投影的远端工作区与会话 + 会话取证。
 *
 * 三段式而不是一个大列表，因为它们回答三个不同的问题：
 * 1. **本机已添加**：向导交出去的那些路径（\`WorkspaceRecord\`），是「我知道哪些目录」；
 * 2. **远端投影**：远端 \`workspace/create\` 认下来的那些（\`ProjectedWorkspaceInfo\`），
 *    是「远端真的存在哪些工作区」——两者不合并（\`ui-design.md\` §3：本地与远端不合并）；
 * 3. **会话**：投影出来的只读摘要 + 一键取证，是 A2「宿主在远端」的证据面。
 *
 * 铁律 4：每个不能点的按钮都带 \`title\` 说明为什么不能点。
 */
/**
 * 失败框「重试」按钮要重跑的那件事。
 *
 * 存意图、不存闭包：闭包会把失败那一刻的表单值一起冻住，用户改完路径点重试仍是旧路径；
 * 而且同一个失败框可能在组件重挂后被点到，闭包里的 `setState` 属于已卸载的实例。
 */
type RetryIntent = {
    readonly kind: 'attach';
    readonly record: WorkspaceRecord;
} | {
    readonly kind: 'ssh-attach';
} | {
    readonly kind: 'create-session';
    readonly workspaceId: string;
} | {
    readonly kind: 'link';
    readonly action: 'disconnect' | 'reconnect';
} | {
    readonly kind: 'probe';
    readonly sessionId: string;
};
export declare function RemoteCrPanel(): unknown;
export {};
//# sourceMappingURL=panel-view.d.ts.map