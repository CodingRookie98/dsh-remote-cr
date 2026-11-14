/**
 * 「连接一个远端」的**分阶段进度 / 取消 / 错误**状态机（纯逻辑，两侧共用）。
 *
 * 为什么在共享层：宿主半要按阶段上报（探测→引导→校验→启动→隧道→屏障→接入），
 * 浏览器半要按阶段渲染（进度条文案、可取消性、错误分阶段可复制）。两侧各写一份
 * 必然漂移，所以只有这一份，宿主半 `emit` 的与浏览器半 `render` 的是同一个类型。
 *
 * 三条硬约束（都有单测）：
 * 1. **阶段只能前进**。回退说明实现里出现了「先启动再探测」这种顺序错误，直接抛错
 *    比默默渲染一个倒着走的进度条好。
 * 2. **取消只对进行中有效**。已失败/已完成之后再取消是 no-op —— 否则 UI 会把一个
 *    已经收口的失败改写成「已取消」，用户就看不到真正的错误码了（铁律 4）。
 * 3. **失败必须带可复制文本**。`flowReport()` 的输出就是「复制日志」按钮的内容，
 *    缺任何一段都算不完整。
 *
 * 与 `src/local/backend/errors.ts` 的关系：那边是**抛出的异常类**（带 `Error` 原型、
 * 栈、`cause`），这边是**跨线程/跨进程传输的普通对象**。`TeleportError` 结构上满足
 * `FlowError`（有单测盯着这条），所以宿主半可以直接把异常塞进状态。
 */
/** 连接要经过的阶段，顺序即进度条顺序（与 `errors.ts#CONNECTION_PHASES` 同源）。 */
export declare const FLOW_PHASES: readonly ["probe", "bootstrap", "verify", "launch", "tunnel", "barrier", "attach"];
export type FlowPhase = (typeof FLOW_PHASES)[number];
/** 每个阶段给用户看的一句话。文案稳定便于断言与截图对比。 */
export declare const FLOW_PHASE_LABELS: Readonly<Record<FlowPhase, string>>;
/** `running` 才可取消；`done`/`failed`/`cancelled` 都是终态。 */
export type FlowStatus = 'idle' | 'running' | 'done' | 'failed' | 'cancelled';
/** 跨进程传输的错误形态；`TeleportError` 结构上满足它。 */
export interface FlowError {
    readonly code: string;
    readonly phase: FlowPhase;
    readonly detail: string;
    readonly nextActions: readonly string[];
    readonly logTail: string;
}
export interface FlowState {
    readonly status: FlowStatus;
    /** 当前（或最后停留的）阶段；`idle` 时为 `probe`。 */
    readonly phase: FlowPhase;
    /** 已完成的阶段，按完成顺序。 */
    readonly completed: readonly FlowPhase[];
    readonly error: FlowError | undefined;
}
/** 还没开始：阶段停在第一个，什么都不算完成。 */
export declare function initialFlow(): FlowState;
/** 开始连接。已经跑过/失败过的状态可以从这里重新来一遍。 */
export declare function startFlow(): FlowState;
/**
 * 进入下一个阶段，把当前阶段记进 `completed`。
 *
 * 只允许**前进**：目标阶段的序号小于当前阶段序号时抛错。跳阶段是允许的（例如
 * `reuse` 档不需要 `bootstrap`），但倒退不行。
 */
export declare function enterPhase(state: FlowState, phase: FlowPhase): FlowState;
/** 成功收口。最后停留的阶段也算完成。 */
export declare function completeFlow(state: FlowState): FlowState;
/** 失败收口：错误自带阶段，用它覆盖当前阶段（错误发生的阶段才是真相）。 */
export declare function failFlow(state: FlowState, error: FlowError): FlowState;
/**
 * 用户取消。
 *
 * 只对 `running` 生效：终态之后再取消是 no-op，**不能**把 `failed` 改写成
 * `cancelled`——那会把真正的错误码从用户眼前抹掉。
 */
export declare function cancelFlow(state: FlowState): FlowState;
/** 进度百分比（0–100）。已完成阶段数 ÷ 总阶段数，不含当前阶段。 */
export declare function progressOf(state: FlowState): number;
/** 是否该显示取消按钮：只有进行中才有意义。 */
export declare function canCancel(state: FlowState): boolean;
/** 供 UI 的一行文案，稳定便于断言。 */
export declare function describeFlow(state: FlowState): string;
/**
 * 「复制日志」按钮的内容。
 *
 * 四段缺一不可：码（可 grep）、阶段（决定归因）、说明（含实测值）、下一步（可执行）。
 * 日志尾只在真有内容时出现，避免给用户一个空的 `--- log ---` 段。
 */
export declare function flowReport(state: FlowState): string;
