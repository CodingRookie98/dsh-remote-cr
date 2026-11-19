/**
 * 多 host 的**容器**（RFC-0007 A1+A3）。
 *
 * 分工：`ProjectionService` 已经是「一台远端一个引擎」（自己的 store / 连接 / 重连驱动 / 槽位），
 * 这里只负责「按 target 持有多个引擎」，并按需选择。**不改** service 内部 —— 在 858 行的状态机上
 * 再动刀，比加一层容器危险得多。
 *
 * A3 加了两件事：
 * 1. **端口分配**：同主机（WSL 同 distro / SSH 同 alias）的两个 target 若都要同一个端口，
 *    第二个改用池 8941–8961 里的空闲端口——否则只会在启动阶段报 `remote/port-in-use`，
 *    用户看不出是「另一个 target 占着」；
 * 2. **引用计数**：一个 target 可被多个工作区引用，**最后一个引用释放才 `recycle()`**；
 *    否则关掉一个工作区会连带杀掉另一个工作区正在用的远端进程。
 */
import type { AttachRequest, AttachResult } from './attach.ts';
import { type AttachControl, type ConnectTarget, ProjectionService, type ProjectionSnapshot } from './service.ts';
/** target 的稳定键：与 `sameTarget` 同形（后端 + 标识 + 端口 + 检出根）。 */
export declare function targetKeyOf(target: ConnectTarget): string;
/** 同一台远端主机（不含端口/目录）：端口冲突只发生在同一台主机上。 */
export declare function sameHostOf(left: ConnectTarget, right: ConnectTarget): boolean;
export interface HubEntry {
    readonly key: string;
    /** 调用方给的 target（地址与目录）；`key` 以它为准。 */
    readonly target: ConnectTarget;
    /** 实际用于连接的 target（端口可能与请求的不同，见 `portAdjusted`）。 */
    readonly effective: ConnectTarget;
    readonly portAdjusted: boolean;
    readonly references: number;
    readonly service: ProjectionService;
}
export declare class ProjectionHub {
    #private;
    constructor(create: () => ProjectionService);
    /** 取（或新建）某 target 的引擎。同一 target 永远返回同一个实例。 */
    serviceFor(target: ConnectTarget): ProjectionService;
    /** 只查不建：`?target=` 指向一台从没接过的机器时不该顺手造一个空引擎。 */
    peek(target: ConnectTarget): ProjectionService | undefined;
    /** 经容器接入：建/复用引擎 → 记 focus → 引用 +1 → 委托给引擎。 */
    attach(target: ConnectTarget, request: AttachRequest, control?: AttachControl): Promise<AttachResult>;
    /**
     * 释放一个引用：最后一个引用才 `recycle()`（停远端、释放端口），但**保留投影条目**。
     * 重复释放不抛（与 `ReferenceCounter` 的语义一致）。
     */
    release(target: ConnectTarget): {
        readonly remaining: number;
        readonly recycled: boolean;
    };
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