/**
 * 多 host 的**容器**（RFC-0007 方案 A1）。
 *
 * 分工：`ProjectionService` 已经是「一台远端一个引擎」（自己的 store / 连接 / 重连驱动 / 槽位），
 * 这里只负责「按 target 持有多个引擎」，并按需选择。**不改** service 内部 —— 在 858 行的状态机上
 * 再动刀，比加一层容器危险得多。
 *
 * 纪律：
 * 1. **同一 target 复用同一个实例**：attach 两次不该丢投影、也不该起第二个连接；
 * 2. **focus 只影响「不带 target 的读」**：`/projection` 省略 target 时返回最近 attach 的那台，
 *    单主机行为因此逐字不变；
 * 3. **dispose 级联且幂等**：容器销毁要把每台都收干净，重复调用不抛。
 */
import type { AttachRequest, AttachResult } from './attach.ts';
import { type AttachControl, type ConnectTarget, ProjectionService, type ProjectionSnapshot } from './service.ts';
/** target 的稳定键：与 `sameTarget` 同形（后端 + 标识 + 端口 + 检出根）。 */
export declare function targetKeyOf(target: ConnectTarget): string;
export interface HubEntry {
    readonly key: string;
    readonly target: ConnectTarget;
    readonly service: ProjectionService;
}
export declare class ProjectionHub {
    #private;
    constructor(create: () => ProjectionService);
    /** 取（或新建）某 target 的引擎。同一 target 永远返回同一个实例。 */
    serviceFor(target: ConnectTarget): ProjectionService;
    /** 只查不建：`?target=` 指向一台从没接过的机器时不该顺手造一个空引擎。 */
    peek(target: ConnectTarget): ProjectionService | undefined;
    /** 经容器接入：建/复用引擎 → 记为 focus → 委托给引擎。 */
    attach(target: ConnectTarget, request: AttachRequest, control?: AttachControl): Promise<AttachResult>;
    /** 最近一次 attach 的引擎（单主机路径的默认读目标）。 */
    focused(): ProjectionService | null;
    snapshotOf(target: ConnectTarget): ProjectionSnapshot | null;
    /** 全部已登记的 target（新建顺序）。 */
    entries(): HubEntry[];
    get size(): number;
    /** 级联 dispose；幂等。清空后容器可继续用（下次 attach 会新建引擎）。 */
    disposeAll(): void;
}
//# sourceMappingURL=hub.d.ts.map