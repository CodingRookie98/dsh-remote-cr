/**
 * 「添加工作区」向导的**纯状态机**（浏览器半）。
 *
 * 为什么把状态抽出来而不是塞进组件里：这个向导有 7 个步骤、3 条失败支路、一次
 * 后台流程轮询，全写在 `useState` 里就只能靠点浏览器验证。抽成纯函数后每条
 * 转移都能在 node 里断言，组件只剩「把状态渲染成 DOM」这一件事。
 *
 * 步骤与验收口径的对应（`milestones.md` M1 / P3.4）：
 * - `choose`：四选一（本机 / WSL / SSH-灰 / Docker-灰），不可用的来源**不静默隐藏**，
 *   而是灰显 + 写明原因（铁律 4：失败要响）；
 * - `browse`：目录浏览走插件自有路由（官方 `listDirectory` 在本机回环宿主上不可用）；
 * - `running`：分阶段进度 + 可取消；
 * - `done`/`failed`/`cancelled`：终态，失败必须能一键复制四段报告。
 */
import type { DirListing, FlowSnapshot, SourceDefaults, WorkspaceAddInput } from '../shared/api.ts';
import type { SourceOption, WorkspaceSource } from '../shared/choices.ts';
import { type FlowState } from '../shared/flow.ts';
/** 向导当前停在哪一屏。终态三选一（done / failed / cancelled）互斥。 */
export type WizardStep = 'closed' | 'choose' | 'browse' | 'running' | 'done' | 'failed' | 'cancelled';
export interface WizardState {
    readonly step: WizardStep;
    /** 四选一 + 发行版清单；尚未探测成功时为 null。 */
    readonly options: readonly SourceOption[] | null;
    readonly distros: readonly {
        readonly name: string;
        readonly state: string;
        readonly version: number | undefined;
        readonly isDefault: boolean;
    }[];
    /** 探测失败的原因（没有 wsl.exe 之类）；成功为 null。 */
    readonly sourcesError: string | null;
    readonly source: WorkspaceSource | null;
    readonly distro: string | null;
    /** 当前浏览到的路径。 */
    readonly path: string;
    readonly listing: DirListing | null;
    readonly listingError: string | null;
    /** 后台流程快照；未发起时为 null。 */
    readonly flow: FlowSnapshot | null;
    /**
     * 接入远端用的默认值（端口 + 检出根）。
     *
     * 跟着 `/sources` 一起回来：它们是同一台机器的部署事实，分两次请求只会让
     * 面板多一个「还不知道端口」的中间态。检出根没配置时是空串，面板据此
     * 明确拒绝接入而不是猜一个路径。
     */
    readonly defaults: SourceDefaults;
}
/** 初始（关闭）状态。`sources` 缓存不清，重开时不必再探测一遍。 */
export declare function initialWizard(): WizardState;
/** 打开向导：回到第一屏，清掉上一轮的流程与错误，保留来源探测结果。 */
export declare function openWizard(state: WizardState): WizardState;
/** 关闭向导（owner 撤回）。 */
export declare function closeWizard(state: WizardState): WizardState;
/** 默认选中的发行版：优先默认发行版，否则第一个。都没有则为 null。 */
export declare function defaultDistro(distros: WizardState['distros']): string | null;
/** 探测结果回来了。`wslAvailable` 为假时仍然把原因留下，UI 要显示它。 */
export declare function receiveSources(state: WizardState, payload: {
    readonly options: readonly SourceOption[];
    readonly distros: WizardState['distros'];
    readonly probeError: string | null;
    readonly defaults: SourceDefaults;
}): WizardState;
/** 探测本身失败（路由 500、网络断）。与「探测成功但没装 WSL」是两件事，分开记。 */
export declare function failSources(state: WizardState, message: string): WizardState;
/** 选一个来源。不可用的来源**不许选中**——灰显只是外观，这里是真正的门。 */
export declare function selectSource(state: WizardState, id: WorkspaceSource): WizardState;
/** 选一个发行版（只对 WSL 分支有意义）。 */
export declare function selectDistro(state: WizardState, name: string): WizardState;
/**
 * 能否进入目录浏览。
 *
 * 本机分支不需要发行版；WSL 分支必须有。这条判定与宿主半的校验**同源同义**，
 * 两边都拦一次不是冗余：UI 拦是为了不让用户白等一次请求，宿主拦是因为
 * 请求可以绕过 UI 直接发。
 */
export declare function canBrowse(state: WizardState): boolean;
/** 进入浏览屏，并给出起始路径。 */
export declare function enterBrowse(state: WizardState, startPath: string): WizardState;
export declare function receiveListing(state: WizardState, listing: DirListing): WizardState;
export declare function failListing(state: WizardState, message: string): WizardState;
/** 把当前选择包成宿主半要的入参。 */
export declare function addInputOf(state: WizardState): WorkspaceAddInput;
/** 发起后台流程：立刻进 `running` 屏（宿主回的是 running 快照）。 */
export declare function beginFlow(state: WizardState, snapshot: FlowSnapshot): WizardState;
/** 轮询到新快照。 */
export declare function receiveFlow(state: WizardState, snapshot: FlowSnapshot): WizardState;
/** 流程状态 → 屏幕。终态之后不再被后续快照改回 running（轮询晚到的旧快照不能翻案）。 */
export declare function stepOf(flow: FlowState): WizardStep;
/** 已进入终态就不再接受新的 running 快照。 */
export declare function isTerminal(state: WizardState): boolean;
/** 终态后仍要轮询吗：只有 running 需要。 */
export declare function shouldPoll(state: WizardState): boolean;
/** 进度百分比；没有流程时为 0。 */
export declare function progressPercent(state: WizardState): number;
/**
 * 「复制日志」的内容。
 *
 * 四段（码 / 阶段 / 说明 / 下一步）来自 `shared/flow.ts#flowReport`——两侧同一份，
 * 保证用户复制到的与宿主日志里记的是同一组事实。没失败时给一段人话，让按钮永远
 * 有内容可复制（空剪贴板是最让人困惑的一种「成功」）。
 */
export declare function reportOf(state: WizardState): string;
/** 把 flow 的成果转成给 owner 的路径；还没成功时为 null。 */
export declare function pickedPathOf(state: WizardState): string | null;
