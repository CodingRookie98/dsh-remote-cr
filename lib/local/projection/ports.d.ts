/**
 * 本地端口分配器（RFC-0007 A3）。
 *
 * 为什么需要：多 host 同时在线时，同一台机器上的两个 target（同 distro、不同目录）会各自要同一个远端端口；
 * 端口撞了只会在启动阶段报 `remote/port-in-use`，而用户看不出是「另一个 target 占着」。
 *
 * 规则：
 * 1. 端口池固定 `8941–8961`（AGENTS 里约定的占用范围），**不在池里的一律拒绝**；
 * 2. `reserve(preferred)` 优先给首选端口，被占则顺延找第一个空闲；池满抛 `PortPoolExhausted`；
 * 3. `release` 幂等；`used()` 返回已占用集合（诊断与测试用）。
 */
export declare const PORT_POOL_START = 8941;
export declare const PORT_POOL_END = 8961;
export declare class PortPoolExhausted extends Error {
    readonly preferred: number;
    constructor(preferred: number);
}
export declare class PortAllocator {
    #private;
    /** 取第一个「既没被分配器发出去、也不在 `taken` 里」的池内端口（`taken` = 已被别的 target 实际占用的端口）。 */
    reserveAvoiding(taken: readonly number[]): number;
    /** 不管首选是否在池内，直接从池里取第一个空闲（宿主端口由用户/配置给、可能不在池内时用）。 */
    reserveAny(): number;
    /** 预留一个端口：首选空闲就用它，否则在池内顺延。 */
    reserve(preferred: number): number;
    /** 归还（幂等）。 */
    release(port: number): void;
    used(): number[];
}
//# sourceMappingURL=ports.d.ts.map