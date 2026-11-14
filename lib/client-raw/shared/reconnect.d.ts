/**
 * 三段退避 + `offline` 重连状态机。
 *
 * 为什么自建：官方 `@deepseek-ai/dsh-client-connection` 的 `ConnectionState` 只有
 * `connected | disconnected | connecting` 三态，`disconnected` 只由浏览器的
 * `online`/`offline` 事件驱动（Node 侧永不出现），退避是 `500ms × 2` 封顶 `10s`
 * 的抖动式重试。产品规格要的是 `2s / 4s / 8s` 各试三轮、再进 `offline` 每 2 分钟
 * 试一次，且手动重连要把计数器打回最开始 —— 这层语义只能自建。
 * 取证见 `spikes/m1/cross-machine-t6/probe.cjs`（T6-4b / T6-4c / T6-4d）。
 *
 * 本模块是纯函数核心，不持有定时器；真正的调度由调用方驱动（`ReconnectDriver`），
 * 这样单测不睡真实时间。
 */
/** 一轮退避的三档间隔，按序试完算一轮。 */
export declare const RECONNECT_STEPS_MS: readonly [2000, 4000, 8000];
/** 退避轮数；`RECONNECT_STEPS_MS.length × RECONNECT_ROUNDS` = 9 次尝试后进离线。 */
export declare const RECONNECT_ROUNDS = 3;
/** 进入 `offline` 后的重试间隔。 */
export declare const OFFLINE_RETRY_MS = 120000;
/** `retrying` = 还在三段退避里；`offline` = 已放弃快速重连、转低频重试。 */
export type ReconnectPhase = 'retrying' | 'offline';
export interface ReconnectState {
    /** 自上次连接成功以来已排定的重试次数（0 表示下一次是第一次重试）。 */
    readonly attempt: number;
    readonly phase: ReconnectPhase;
}
/** 断线瞬间的状态：还没排过任何重试。 */
export declare function initialReconnectState(): ReconnectState;
/** 连接成功 —— 计数器归零，回到快速重连档。手动重连也走这里。 */
export declare function afterConnected(): ReconnectState;
/** 手动重连：语义上等同于「已经连上过一次」，把三段退避重新从 2s 开始。 */
export declare function afterManualReconnect(): ReconnectState;
/**
 * 排出下一次重试要等多久，并给出排完之后的状态。
 *
 * 第 1–9 次走 `2s / 4s / 8s` 循环（`RECONNECT_ROUNDS` 轮），第 10 次起转 `offline`
 * 并按 `OFFLINE_RETRY_MS` 等。`attempt` 始终递增，调用方可以据此区分「同一档位的
 * 第几次」。
 */
export declare function planRetry(state: ReconnectState): {
    delayMs: number;
    next: ReconnectState;
};
/** 供日志与 UI 的一行稳定描述，便于 grep 与断言。 */
export declare function describeReconnect(state: ReconnectState): string;
/** 定时器的最小接缝；单测注入假实现，生产用全局 `setTimeout`/`clearTimeout`。 */
export interface ReconnectTimers {
    schedule(delayMs: number, run: () => void): unknown;
    cancel(handle: unknown): void;
}
export declare const defaultTimers: ReconnectTimers;
/**
 * 把纯函数核心接上定时器与「尝试连接」回调。
 *
 * 调用方职责：`start()` 表示刚断线；每次定时器到点会调用 `attempt`，成功则调用
 * `settle()`，失败则什么都不用做（本类在 `attempt` 抛错时自动排下一次）。
 */
export declare class ReconnectDriver {
    #private;
    constructor(options: {
        attempt: () => Promise<void>;
        timers?: ReconnectTimers;
        onSchedule?: (delayMs: number, state: ReconnectState) => void;
    });
    get state(): ReconnectState;
    /** 从「刚断线」开始排第一次重试。 */
    start(): void;
    /** 连接成功：清掉待触发的重试，计数器归零。 */
    settle(): void;
    /** 手动重连：立刻试一次，并把三段退避从头开始。 */
    reconnectNow(): void;
    dispose(): void;
}
/**
 * 连接相位：面板能看到的四种状态。
 *
 * 为什么不直接用 `ReconnectPhase`：那个只有 `retrying`/`offline`，是**调度器**的内部
 * 两态，缺了「从没连过」（`idle`）和「连上了」（`connected`）。凑成四态才能让快照
 * 一句话说清当前处境，而且四下分支穷尽，新增状态会被 `switch` 的返回类型挡住。
 */
export type LinkPhase = 'idle' | 'connected' | 'retrying' | 'offline';
/** 相位的人话说明；宿主半写快照、面板写状态行，共用同一份措辞。 */
export declare function describeLink(phase: LinkPhase): string;
