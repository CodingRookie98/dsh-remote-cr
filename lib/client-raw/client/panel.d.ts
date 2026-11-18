/**
 * 「远端工作台」面板的**纯逻辑**（浏览器半）。
 *
 * 面板要做的三件事里有三件都能在 node 里断言：能不能接入、接入要发什么、
 * 取证结果怎么读。把它们抽出来，组件就只剩渲染，和 \`state.ts\` 对向导做的事一样。
 *
 * 一条纪律：**「为什么不能」必须说出来**。灰按钮不写原因，用户只会以为坏了
 * （铁律 4：失败要响）。
 */
import type { AttachInput, ProbeOutcome, ProjectionSnapshotInfo, RemoteTargetInfo, SourceDefaults, SshTargetInfo, WorkspaceRecord } from '../shared/api.ts';
import type { AttachPhase } from '../shared/phases.ts';
import { type FlowPhase, type FlowState } from '../shared/flow.ts';
import type { SourceOption } from '../shared/choices.ts';
/** 接入计划：能接就给出完整入参，不能接就给出人话原因。 */
export type AttachPlan = {
    readonly ok: true;
    readonly input: AttachInput;
} | {
    readonly ok: false;
    readonly reason: string;
};
/**
 * 把一条「添加工作区」的成果翻译成一次远端接入。
 *
 * 为什么不直接在面板里拼：\`localPath\` 必须与 wizard 交给 owner 的**同一个**
 * UNC 路径一致，否则本地会出现两条指向同一目录的工作区记录。这里只做推导，
 * 真正的注册仍由远端 \`workspace/create\` 决定 id。
 */
export declare function planAttach(record: WorkspaceRecord, defaults: SourceDefaults): AttachPlan;
/**
 * SSH 目标的接入计划。
 *
 * 与 `planAttach` 的区别是**没有本地路径**：WSL 的 `localPath` 能从发行版名推出 UNC，
 * SSH 推不出来（远端 `/home/x` 在本地没有任何约定俗成的落点），所以 `localPath` 留空，
 * 由宿主半的锚点落实器建目录并回填。面板这里**不猜**——猜出来的路径会让宿主把工作区
 * 建在一个不存在的地方，之后所有读写都落在错的位置还不报错。
 */
export declare function planSshAttach(draft: {
    readonly alias: string;
    readonly remotePath: string;
}, defaults: SourceDefaults): AttachPlan;
/**
 * SSH 接入按钮的可点性。
 *
 * 单独一个函数而不是就用 `planSshAttach` 的 ok：后者在用户**还没输入路径**时
 * 就已经返回 false 了，但那不是「坏了」，是「还没填」。两者文案必须不同，
 * 否则用户一打开面板就看到一条红字。
 */
export declare function sshAttachPlan(hosts: readonly SshTargetInfo[], draft: {
    readonly alias: string;
    readonly remotePath: string;
}, defaults: SourceDefaults): ButtonPlan;
/** 远端路径的最后一段，用作工作区标题；根路径退化成整串。 */
export declare function basenameOf(posixPath: string): string;
/**
 * 取证结论的**可复制报告**。
 *
 * 与 \`shared/flow.ts#flowReport\` 同构：先结论、再证据、最后原始输出。
 * 用户贴给别人的应该是一段能自证的东西，而不是「失败了」三个字。
 */
export declare function probeReport(outcome: ProbeOutcome): string;
/** 一句话结论（面板行内显示，不用展开报告就能看懂）。 */
export declare function probeSummary(outcome: ProbeOutcome): string;
/** 一个按钮能不能点；不能点时必须说明原因（铁律 4）。 */
export type ButtonPlan = {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly reason: string;
};
/**
 * 连接目标的短标识：WSL 显示发行版名，SSH 显示 config 别名。
 *
 * 单独一个函数而不是就地三元：面板与日志都要这句摘要，两处各写一遍迟早只改一处。
 */
export declare function describeTargetInfo(target: RemoteTargetInfo): string;
/**
 * 环境档位的一句话。
 *
 * 必须显示而不是只存着：用户选了隔离档却静默按复用档跑，是这一档最糟的失败形态——
 * 它不报错，只是环境悄悄不是你以为的那个。反过来，配置写错时这里会显示「未知」。
 */
export declare function envPolicyLine(snapshot: ProjectionSnapshotInfo | null): string;
/**
 * 接入阶段的人话。A5 要求「分阶段进度」对用户可见——只显示「接入中…」等于没给进度。
 * 阶段词的真相源是 `src/shared/phases.ts`，这里只负责翻译，不新增阶段。
 */
export declare function attachPhaseText(phase: AttachPhase): string;
/** 流程进度的一行文案（阶段名 + 完成数），阶段名走 `phase.*` 字典。 */
export declare function flowLine(state: FlowState): string;
/** 阶段名（`probe` → 「探测远端…」），面板与向导共用。 */
export declare function phaseLabel(phase: FlowPhase): string;
/** 来源的短标签（共享层只给 id）。 */
export declare function sourceLabel(option: SourceOption): string;
/**
 * 来源不可用的原因（**只渲染本地化文案**）。
 *
 * `reasonDetail` 是宿主探测到的原文（中文），只进「复制日志」，不进可见行——
 * 否则英文界面上会冒出「Probing WSL failed: wsl.exe --list 退出码 1」（Delta-5 U1 残留）。
 */
export declare function sourceReasonText(option: SourceOption): string;
/** 不可用原因的宿主原文：只给复制日志用，不参与渲染。 */
export declare function sourceReasonDetail(option: SourceOption): string;
/**
 * 连接状态行的一句话。
 *
 * 只读 `link` 而不看 `connected`：后者只说「现在能不能发 RPC」，说不了
 * 「是没连过，还是掉线正在重试」——而这恰恰是用户按下按钮前最想知道的。
 * 文案走 `LINK_KEYS` → 字典（ADR-0007：共享层不再产出文案）。
 */
export declare function linkLine(snapshot: ProjectionSnapshotInfo | null): string;
/**
 * 「重连」按钮的可点性。
 *
 * 三种不点的情况各有各的原因，含糊成一句「不可用」等于让用户猜：
 * 还没读到投影、压根没连过（没有目标可连回）、以及本来就连着（点了没意义）。
 */
export declare function reconnectPlan(snapshot: ProjectionSnapshotInfo | null): ButtonPlan;
/** 「断开」按钮的可点性：没连过就没什么可断开的。 */
export declare function disconnectPlan(snapshot: ProjectionSnapshotInfo | null): ButtonPlan;
/** 失败面里要渲染给用户的最小形状（`PanelFailure` 结构上满足它）。 */
export interface FailureLike {
    readonly code: string;
    readonly detail: string;
    readonly nextActions: readonly string[];
}
/** 本地化后的失败面：可见文案；宿主原文只进「复制日志」。 */
export interface LocalizedFailure {
    readonly detail: string;
    readonly nextActions: readonly string[];
    /** 是否命中了字典（false 表示回落宿主原文，通常意味着新增错误码还没配译文）。 */
    readonly localized: boolean;
}
/**
 * 按错误码本地化失败面（R2 裁决的 B2 修法：不改 115 处宿主文案，只在客户端按 `code` 取译文）。
 *
 * 三条约定：
 * 1. `err.<code>` 命中 → 用它当 detail，`errNext.<code>` 命中 → 用它当下一步（` · ` 分隔）；
 * 2. 任一键未命中 → **整条回落宿主原文**，不混排中英（宁可整句中文，也不给半句英文）；
 * 3. 宿主 `detail` 永远保留在 `PanelFailure.report` 里，用户仍可复制完整证据。
 * @param failure - 结构化失败（code + detail + nextActions）。
 * @returns 本地化结果与命中标记。
 */
export declare function localizeFailure(failure: FailureLike): LocalizedFailure;
/**
 * 把任意异常折成「可本地化的失败面」。
 *
 * 宿主半的错误都带 `code`（`RemoteCrApiError` / 线上信封），本地化只需要 code；
 * 不是结构化错误（真正的 `TypeError` 之类）才退回原文。
 * @param error - 捕获到的任意异常。
 * @param describe - 取原文的函数（默认见下；注入以便单测）。
 * @returns 结构化失败，或原文（说明这条异常没有码可用）。
 */
export declare function failureFromError(error: unknown, describe?: (value: unknown) => string): FailureLike | string;
/** 默认的原文提取：`Error.message` 优先，其余 `String()`。 */
export declare function describeError(error: unknown): string;
/**
 * 时间显示。
 *
 * 远端给的是 ISO-8601；解析不了就原样返回，**不拿本地时钟编一个**——
 * 编出来的时间会让「这条会话是旧的」这种判断变成假的。
 */
export declare function formatUpdatedAt(iso: string | undefined, now?: number): string;
