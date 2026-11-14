/**
 * 瞬移面板与「添加工作区」向导的组件（浏览器半，零 JSX）。
 *
 * 为什么不用 `.tsx`：`tsconfig.client.json` 只收 `.ts`，且本仓库不装 `@types/react`
 * ——宿主模块表提供 `react` 运行时，我们只声明真正用到的几个 API
 * （`src/client/react.d.ts`）。手写 `createElement` 反而让「到底用了哪些 API」一目了然。
 *
 * 三条纪律：
 * 1. **不静默降级**：不可用的来源灰显并写明原因；失败给四段可复制报告，不吞错。
 * 2. **`onPicked` 每次 `open` 恰好一次**：`DirectoryFlowOwnerProps` 的契约
 *    （`ui-design.md` §4），重复回传会让 owner 反复 createWorkspace。
 * 3. **不许 import `node:*`**：这一半进浏览器包，node 内建在模块表里解析不到。
 *
 * 本文件同时被两套 tsconfig 编译：根 `tsconfig.json`（node lib，无 DOM）与
 * `tsconfig.client.json`（含 DOM）。所以这里**只用两边都有的全局**，DOM 专属的
 * 东西（如 `navigator.clipboard`）一律走本地窄接口取，而不是依赖 `lib.dom`。
 */
import type { WorkspaceRecord } from '../shared/api.ts';
import { type WizardState } from './state.ts';
type AnyProps = Record<string, unknown>;
/**
 * 面板上的失败。A8 要求「结构化错误码 + 可复制日志 + 重试入口」，
 * 所以这里存的不是一句话，而是那三件东西本身。
 *
 * `report` 是给用户粘到 issue 里的整份文本：错误码、原因、下一步、以及原始异常；
 * 它必须自足——只复制错误码，收到的人还得回来问细节。
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
/** 拼接子目录：本机用反斜杠，distro 内用正斜杠。 */
export declare function joinPath(base: string, name: string): string;
/**
 * 剪贴板写入。
 *
 * 不直接用 `navigator.clipboard`：本文件也被根 `tsconfig.json`（`lib: es2024`，
 * 无 DOM）编译，那里没有 `Navigator.clipboard` 这个成员。用一个窄接口取，
 * 拿不到就返回 false —— 某些上下文会拒剪贴板权限，不能因此抛错。
 */
export declare function copyText(text: string): Promise<boolean>;
/**
 * 「添加工作区」向导。
 *
 * 挂在 `conversation.hero.workspace.directoryFlow` 与 `sidebar.workspaces.directoryFlow`
 * 两个洞上，用 `priority: -1` 抢在官方浏览对话框之前。owner props 是摊平进来的
 * （`ui-renderer` 的 scoped-slots 行为，M0 实测 V12），所以直接从 props 取。
 */
export declare function DirectoryFlow(props: AnyProps): unknown;
/** 侧栏图标：与 `main` 面板同 id/key 配对（M0 实测 V2，缺一个另一个就不显示）。 */
export declare function TeleportIcon(): unknown;
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
export declare function TeleportPanel(): unknown;
/** 初始状态导出给诊断面用（避免 `initialWizard` 在组件里被误当成可变单例）。 */
export declare const WIZARD_INITIAL: WizardState;
export {};
