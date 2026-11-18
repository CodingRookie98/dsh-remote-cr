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
 * 栈、`cause`），这边是**跨线程/跨进程传输的普通对象**。`RemoteCrError` 结构上满足
 * `FlowError`（有单测盯着这条），所以宿主半可以直接把异常塞进状态。
 */
/** 连接要经过的阶段，顺序即进度条顺序（与 `errors.ts#CONNECTION_PHASES` 同源）。 */
export const FLOW_PHASES = ['probe', 'bootstrap', 'verify', 'launch', 'tunnel', 'barrier', 'attach'];
/** 阶段总数（进度条分母）。 */
export const FLOW_PHASE_COUNT = FLOW_PHASES.length;
/** 还没开始：阶段停在第一个，什么都不算完成。 */
export function initialFlow() {
    return { status: 'idle', phase: FLOW_PHASES[0], completed: [], error: undefined };
}
/** 开始连接。已经跑过/失败过的状态可以从这里重新来一遍。 */
export function startFlow() {
    return { status: 'running', phase: FLOW_PHASES[0], completed: [], error: undefined };
}
/**
 * 进入下一个阶段，把当前阶段记进 `completed`。
 *
 * 只允许**前进**：目标阶段的序号小于当前阶段序号时抛错。跳阶段是允许的（例如
 * `reuse` 档不需要 `bootstrap`），但倒退不行。
 */
export function enterPhase(state, phase) {
    if (state.status !== 'running')
        return state;
    const from = FLOW_PHASES.indexOf(state.phase);
    const to = FLOW_PHASES.indexOf(phase);
    if (to < from) {
        throw new RangeError(`flow: cannot move back from "${state.phase}" to "${phase}"`);
    }
    if (to === from)
        return state;
    const completed = [...state.completed, state.phase];
    return { status: 'running', phase, completed, error: undefined };
}
/** 成功收口。最后停留的阶段也算完成。 */
export function completeFlow(state) {
    if (state.status !== 'running')
        return state;
    return { status: 'done', phase: state.phase, completed: [...state.completed, state.phase], error: undefined };
}
/** 失败收口：错误自带阶段，用它覆盖当前阶段（错误发生的阶段才是真相）。 */
export function failFlow(state, error) {
    if (state.status !== 'running')
        return state;
    return { status: 'failed', phase: error.phase, completed: state.completed, error };
}
/**
 * 用户取消。
 *
 * 只对 `running` 生效：终态之后再取消是 no-op，**不能**把 `failed` 改写成
 * `cancelled`——那会把真正的错误码从用户眼前抹掉。
 */
export function cancelFlow(state) {
    if (state.status !== 'running')
        return state;
    return { status: 'cancelled', phase: state.phase, completed: state.completed, error: undefined };
}
/** 进度百分比（0–100）。已完成阶段数 ÷ 总阶段数，不含当前阶段。 */
export function progressOf(state) {
    return Math.round((state.completed.length / FLOW_PHASES.length) * 100);
}
/** 是否该显示取消按钮：只有进行中才有意义。 */
export function canCancel(state) {
    return state.status === 'running';
}
export function flowProgress(state) {
    return {
        status: state.status,
        phase: state.phase,
        completed: state.completed.length,
        total: FLOW_PHASE_COUNT,
        ...(state.error === undefined ? {} : { errorCode: state.error.code }),
    };
}
/**
 * 「复制日志」按钮的内容。
 *
 * 四段缺一不可：码（可 grep）、阶段（决定归因）、说明（含实测值）、下一步（可执行）。
 * 日志尾只在真有内容时出现，避免给用户一个空的 `--- log ---` 段。
 */
export function flowReport(state) {
    const error = state.error;
    if (error === undefined) {
        return [`status: ${state.status}`, `phase: ${state.phase}`, `completed: ${state.completed.join(' -> ') || '(none)'}`].join('\n');
    }
    return [
        `code: ${error.code}`,
        `phase: ${error.phase}`,
        `detail: ${error.detail}`,
        `next: ${error.nextActions.join(' | ')}`,
        error.logTail === '' ? '' : `--- log ---\n${error.logTail}`,
    ]
        .filter((line) => line !== '')
        .join('\n');
}
//# sourceMappingURL=flow.js.map