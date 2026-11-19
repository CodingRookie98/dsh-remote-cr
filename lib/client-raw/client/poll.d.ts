/**
 * 面板后台刷新的**调度器**（M3 · P3.3 / RFC-0004 R3）。
 *
 * 为什么单独一个纯模块：这一片唯一有状态的并发逻辑都在这里（单飞 / 退避 / 可见性），
 * 把它和 React 的生命周期搅在一起，就只能靠「等 5 秒看看」来验证。抽出来之后
 * 「注入 run / isVisible / timer」，node 单测用假定时器就能把每一条语义钉死。
 *
 * 四条语义（R3 的验收面，逐条都有用例）：
 * 1. 到点时**不可见** → 不跑，按当前间隔重排（隐藏不是失败，不推进退避）；
 * 2. 跑成功 → 间隔复位 `intervalMs`；跑失败 → 间隔翻倍、封顶 `maxIntervalMs`；
 * 3. 同一时刻**只允许一个 run 在飞**：在飞期间到点就跳过并重排，不排队（不补跑）；
 * 4. `stop()` 之后任何已经排上的定时器都不许再触发 run —— 那是一次泄漏的刷新。
 *
 * 一条纪律：这里**不碰** `document` / `window`。可见性由调用方注入，
 * 定时器也只是注入面，默认值取 `globalThis.setTimeout`（node 与浏览器都有）。
 *
 * @module dsh-remote-cr/client/poll
 */
/** 调度器需要的定时器面；注入是为了单测能用假定时器（不 sleep、不抖）。 */
export interface RefreshTimer {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}
/** 调度器的入参。 */
export interface RefreshSchedulerOptions {
    /** 跑一次刷新；**rejection 就是失败**（怎么展示错误是调用方的事，调度器只管退避）。 */
    readonly run: () => Promise<void>;
    /** 现在能不能跑（面板注入 `document.visibilityState === 'visible'`）。 */
    readonly isVisible: () => boolean;
    /** 成功后的间隔（毫秒）；默认 5000。 */
    readonly intervalMs?: number;
    /** 退避上限（毫秒）；默认 30000。 */
    readonly maxIntervalMs?: number;
    /** 定时器；默认 `globalThis`。 */
    readonly timer?: RefreshTimer;
}
/** 调度器的对外面。 */
export interface RefreshScheduler {
    /** 起链（幂等：已经在跑就什么都不做）。 */
    start(): void;
    /** 收链：清掉待触发的定时器，之后任何回调都不再跑 run。 */
    stop(): void;
    /** 立刻补一次（「页面重新可见」「用户点重试」）；不可见或在飞时什么都不做。 */
    kick(): void;
    /** 当前间隔：成功后 `intervalMs`，失败后翻倍至 `maxIntervalMs`。 */
    readonly delayMs: number;
}
/**
 * 建一个刷新调度器。
 *
 * @param options - run / isVisible / 间隔 / 定时器（后三者可注入以便单测）。
 * @returns 调度器；`delayMs` 是当前间隔的只读视图。
 */
export declare function createRefreshScheduler(options: RefreshSchedulerOptions): RefreshScheduler;
/**
 * 该不该让调度器跑：RFC-0004 R3 的字面口径是「面板可见时启、**隐藏/断连时停**」。
 *
 * 抽成纯函数是为了让面板只写一处判断（`shouldPoll(...)`），而不是在事件回调与 effect 里
 * 各写一半条件——那种写法漏一个分支就是契约漂移（P4 B3：隐藏时原先只是「到点跳过」，
 * 定时器一直在空转）。
 */
export declare function shouldPoll(state: {
    readonly connected: boolean;
    readonly visible: boolean;
}): boolean;
/** 调度器的控制面（只为 `applyPollState` 可测而抽的最小接口）。 */
export interface PollControl {
    start(): void;
    stop(): void;
    kick(): void;
}
/**
 * 把「该不该跑」落成实际动作：能跑就 `start()` + 立刻补一次；不能跑就 `stop()`。
 *
 * 抽这一层的原因：`shouldPoll` 只回答了「该不该」，而让调度器真的起/停的那四处调用原先直接写在
 * 面板的 effect 里 —— 删掉其中任何一处 `stop()`，845 条测试与 L4 全绿（P4 Delta 的 P2）。
 * 现在面板两处都只调这一个函数，真假两分支各有用例。
 */
export declare function applyPollState(scheduler: PollControl, state: {
    readonly connected: boolean;
    readonly visible: boolean;
}): 'running' | 'stopped';
