/**
 * 同步屏障（`docs/design/architecture.md` §7.1）。
 *
 * 把它写成独立模块而不是「连接代码里的一段」的原因：§7.1 的三条语义都是**时序**语义，
 * 一旦混进连接生命周期就没人能单独证明它们成立：
 *
 * 1. **前置屏障**：首连时只有远端写入返回 `applied` / `already-applied` 才允许发布
 *    `online`；`failed` / `unsupported` 走正式失败通道（`failed` + `retryable: true`），
 *    不能「先连上再说」。
 * 2. **发布后失败只警告**：连接已经 `online` 之后再同步失败，只留结构化 warning，
 *    **不拆连接** —— 一次抖动不该打掉整条连接。
 * 3. **单飞**：同步单位是 host（Environment）不是 workspace；同一 host 同时只允许一次
 *    写入 flight，并发的调用共享同一个 Promise。
 */
/** 远端写入的四种结果码，与 §7.1 原文一一对应。 */
export type WriteOutcome = 'applied' | 'already-applied' | 'failed' | 'unsupported';
/** 屏障是否已过。`passed` 只由 `applied`/`already-applied` 得到。 */
export type BarrierVerdict = 'passed' | 'blocked';
/** 一次唤醒后拿到的完整结论。 */
export interface BarrierResult {
    readonly host: string;
    readonly verdict: BarrierVerdict;
    readonly outcome: WriteOutcome;
    /** 写入失败的原始信息（`failed`/`unsupported` 才有）。 */
    readonly detail?: string;
}
/** 屏障告警；发布后失败时进状态面板。 */
export interface BarrierWarning {
    readonly at: string;
    readonly host: string;
    readonly code: 'sync-failed' | 'sync-unsupported';
    readonly message: string;
}
/** 真正执行远端写入的函数；由调用方注入（WSL/SSH/Docker 各不同）。 */
export type BarrierWrite = (host: string) => Promise<{
    outcome: WriteOutcome;
    detail?: string;
}>;
export interface BarrierOptions {
    readonly write: BarrierWrite;
    /** 已发布（`online`）的 host 集合由调用方维护，屏障只查询不改写。 */
    readonly isPublished: (host: string) => boolean;
    readonly onWarning?: (warning: BarrierWarning) => void;
    /** 当前时间，测试可替换。 */
    readonly now?: () => Date;
}
/**
 * 单 host 的屏障状态机。
 *
 * 一个实例管理多个 host：每个 host 各自单飞，互不阻塞。
 */
export declare class SyncBarrier {
    #private;
    constructor(options: BarrierOptions);
    /** 已完成的最近结论（按 host）；从未跑过为 `undefined`。 */
    lastResult(host: string): BarrierResult | undefined;
    /** 最近若干条告警（新→旧）。 */
    warnings(): readonly BarrierWarning[];
    /** 是否正有一次 flight 在飞（诊断与单飞断言用）。 */
    inFlight(host: string): boolean;
    /**
     * 确保该 host 的屏障已过。
     *
     * 并发调用共享同一个 flight（单飞）；flight 结束后立刻从表里移除，下一次调用发起
     * 新的写入 —— 屏障是「每次连接都要过一遍」的门，不是一次性初始化。
     */
    ensure(host: string): Promise<BarrierResult>;
}
/**
 * 由屏障结论得到连接层该走哪条路。
 *
 * 抽成纯函数是为了让「屏障未过时 UI 不显示已连接」这条验收项可以被单测直接钉住，
 * 而不是只能在真机上靠肉眼观察状态面板。
 */
export declare function connectionGate(result: BarrierResult): {
    publish: 'online';
} | {
    publish: 'failed';
    retryable: true;
    code: string;
    message: string;
};
//# sourceMappingURL=barrier.d.ts.map