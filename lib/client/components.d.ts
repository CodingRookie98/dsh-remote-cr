/**
 * 「远端工作台」面板与「添加工作区」向导的组件（浏览器半，零 JSX）。
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
import { type WizardState } from './state.ts';
type AnyProps = Record<string, unknown>;
export declare function messageOf(error: unknown): string;
/** 更新 store 并返回新状态（读旧值会拿到上一帧，容易写出差一帧的 bug）。 */
export declare function update(mutate: (state: WizardState) => WizardState): WizardState;
/** 订阅 store；退订函数交给 `useEffect`。 */
export declare function useWizard(): WizardState;
/** 拼接子目录：本机用反斜杠，distro 内用正斜杠。 */
export declare function joinPath(base: string, name: string): string;
/**
 * 剪贴板写入。
 *
 * 不直接用 navigator.clipboard：本文件也被根 tsconfig.json（lib: es2024，无 DOM）编译，
 * 那里没有 Navigator.clipboard 这个成员。用一个窄接口取，拿不到就返回 false ——
 * 某些上下文会拒剪贴板权限，不能因此抛错。
 */
export declare function copyText(text: string): Promise<boolean>;
/** 「复制诊断」的内容：码 / 发行版 / wsl 错误码 / 人话 / 下一步 / 原文，缺一段就没法贴给别人看。 */
export declare function wakeReportOf(state: WizardState): string;
/**
 * 会话行上的「远端」徽标（RFC-0003 R2-3）。
 *
 * 挂在 DSH 自己的侧栏会话行上（hole: sidebar.session.row.leading，props 只有 sessionId），
 * 所以它**不能**读面板的局部 state：数据源是模块级 `remoteSessionIndex`（面板与徽标共用）。
 * 每次挂载触发一次 refresh；索引失败时保留上次结果，徽标不会闪没。
 */
export declare function sessionBadge(props?: {
    readonly sessionId?: unknown;
}): unknown;
/**
 * 同步对话框（RFC-0003 需求①）。
 *
 * 纯展示：状态由 `sync-state.ts` 的模型算好，这里只画与回调。五态都要能画出来——
 * 尤其 `failed`：读远端失败时必须给码 + 下一步，而不是留一个转圈的对话框。
 */
export declare function SyncDialog(props: {
    readonly state: import('./sync-state.ts').SyncDialogState;
    readonly onToggle: (name: string) => void;
    readonly onSelectAll: (select: boolean) => void;
    readonly onApply: () => void;
    readonly onClose: () => void;
    readonly onRetry: () => void;
    readonly onOptout: (muted: boolean) => void;
    /** 宿主版本对齐（H 系列）。两段式确认的状态由面板持有——对话框本身有早退分支，不能放 hook。 */
    readonly onAlignHost?: () => void;
    readonly hostConfirming?: boolean;
    readonly hostUpgrade?: {
        readonly phase: 'idle' | 'running' | 'done' | 'failed';
        readonly version?: string;
        /** 失败要带码 + 下一步（铁律 4）：只显示 detail 等于把可照抄的出路吞掉。 */
        readonly failure?: {
            readonly code: string;
            readonly detail: string;
            readonly nextActions: readonly string[];
        };
    };
}): unknown;
/**
 * 会话行 `⋯` 菜单里的「重新连接」（RFC-0003 R2-4）。
 *
 * 只对**远端会话**出现（查 remoteSessionIndex）；DSH 会把这个洞渲染成 `role="menuitem"`。
 * 说明：DSH 建议通过 `useMenuOpenState` 主动关菜单；那是个 hook，而我们的「是不是远端会话」
 * 判断必须在 hook 之前完成（否则违反 hook 调用规则），所以这里不注入 hook ——
 * 点击后菜单由宿主自己的点击外部/焦点逻辑收起，功能不受影响。
 */
export declare function sessionReconnectItem(props?: {
    readonly sessionId?: unknown;
}): unknown;
/**
 * 「添加工作区」向导（RFC-0001 双栏工作台）。
 *
 * 挂在 conversation.hero.workspace.directoryFlow 与 sidebar.workspaces.directoryFlow
 * 两个洞上，用 priority: -1 抢在官方浏览对话框之前。owner props 是摊平进来的
 * （ui-renderer 的 scoped-slots 行为，M0 实测 V12），所以直接从 props 取。
 */
export declare function DirectoryFlow(props: AnyProps): unknown;
/** 初始状态导出给诊断面用（避免 `initialWizard` 在组件里被误当成可变单例）。 */
export declare const WIZARD_INITIAL: WizardState;
export {};
//# sourceMappingURL=components.d.ts.map