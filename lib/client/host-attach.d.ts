/**
 * 「添加工作区」完成后的**远端宿主接入**（`architecture.md` §2 第 4–7 步）。
 *
 * 为什么单独一个模块：向导的 `done` 屏要显示接入进度，而组件里已经有六条 effect、
 * 三个 ref，再塞一段 promise 链进去就没人能审了。这里把「该不该接」「接了没」「失败
 * 长什么样」抽成纯函数，组件只负责把状态画出来（与 `state.ts` / `panel.ts` 同一手法）。
 *
 * 一条纪律：**去重按「轮」而不是按「次数」**。组件重挂（切会话、宿主回收插槽）会重跑
 * effect，按次数去重会再起一个远端 dsh；按 `key`（记录 + 目标 + 远端根）去重才不会。
 */
import type { SourceDefaults, WorkspaceRecord } from '../shared/api.ts';
/** 接入阶段。`idle` 也覆盖「这条记录不值得接」的静默情形。 */
export type HostAttachPhase = 'idle' | 'running' | 'done' | 'failed';
export interface HostAttachFailure {
    readonly code: string;
    readonly detail: string;
    readonly nextActions: readonly string[];
}
export interface HostAttachState {
    readonly phase: HostAttachPhase;
    /** 正在接（或接完）的那一条；null 表示还没开始。 */
    readonly key: string | null;
    readonly failure: HostAttachFailure | null;
}
export declare const IDLE_ATTACH: HostAttachState;
/** 跳过接入的结构化原因（文案由调用方从字典取，本模块不碰 i18n）。 */
export type AttachSkipReason = 'closed' | 'not-done' | 'no-record' | 'not-wsl' | 'no-posix' | 'no-remote-root' | 'already';
export interface AttachInput {
    readonly open: boolean;
    readonly step: string;
    readonly record: WorkspaceRecord | null;
    readonly defaults: SourceDefaults;
    readonly current: HostAttachState;
}
export type AttachDecision = {
    readonly kind: 'skip';
    readonly reason: AttachSkipReason;
} | {
    readonly kind: 'start';
    readonly key: string;
};
/**
 * 去重键：同一条记录 × 同一台目标 × 同一个远端根 = 同一件事。
 *
 * 不含端口是有意的：端口在 attach 时由宿主半的池分配，前端拿不到也不该猜；
 * 它变成键的一部分会让「同一记录重试」永远被判定成新任务。
 */
export declare function attachKeyOf(record: WorkspaceRecord, defaults: SourceDefaults): string;
/**
 * 该不该为这条记录发起一次接入。
 *
 * 刻意**不**在缺 `remoteRoot` 时报错：那是部署方没配的默认值，用户在添加工作区的
 * 那一刻无从修；静默跳过 + 面板照常提示「缺 remoteRoot」比在 done 屏摆一条红字好。
 */
export declare function decideAttach(input: AttachInput): AttachDecision;
export declare function beginAttach(current: HostAttachState, key: string): HostAttachState;
export declare function settleAttach(current: HostAttachState, key: string): HostAttachState;
export declare function failAttach(current: HostAttachState, key: string, failure: HostAttachFailure): HostAttachState;
/** 用户点「重试」：清掉失败但**保留 key**，这样 effect 不会把它当成新任务重复触发。 */
export declare function retryAttach(current: HostAttachState): HostAttachState;
//# sourceMappingURL=host-attach.d.ts.map