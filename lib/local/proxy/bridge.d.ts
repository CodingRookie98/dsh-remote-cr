/**
 * WSL 反向通路第 ③ 档的**宿主侧**驱动：把 `wsl.exe --exec` 的 stdin/stdout 当字节管道。
 *
 * 帧格式与 `spikes/m1/wsl-closed-loop/relay.cjs` 逐字节一致（大端）：
 * `[1B type][4B streamId][4B len][payload]`
 *
 * 为什么宿主侧**不需要**能连通 distro 的端口：`TYPE_READY` 里的端口号是给 distro 侧
 * 自己用的（同 distro 内的进程连它），宿主只负责把每条逻辑连接拼到本地凭据代理上。
 * 这样这条通路在 `natural`（NAT）模式下同样成立 —— 而这正是它被定为默认档位的原因。
 */
/** 帧类型；数值属于与 distro 侧中继的对外契约，改动要同步 `relay.cjs` 与文档。 */
export declare const FRAME: {
    readonly DATA: 1;
    readonly OPEN: 2;
    readonly CLOSE: 3;
    readonly READY: 4;
    readonly FIN: 5;
};
export type FrameType = (typeof FRAME)[keyof typeof FRAME];
/** 帧头长度：1 + 4 + 4。 */
export declare const FRAME_HEADER_BYTES = 9;
export interface Frame {
    readonly type: FrameType;
    readonly streamId: number;
    readonly payload: Buffer;
}
/** 编码一帧。 */
export declare function encodeFrame(type: FrameType, streamId: number, payload?: Buffer | string): Buffer;
/** 增量解码器：stdout 是流式的，一帧可能横跨多个 chunk。 */
export declare class FrameDecoder {
    #private;
    /** 喂一块数据，返回本次能完整解出的帧（可能为空）。 */
    push(chunk: Buffer): Frame[];
    /** 还有多少字节卡在半帧里（诊断用；正常收尾时应为 0）。 */
    get pending(): number;
}
/** 宿主侧为每条逻辑连接建到本地代理的 socket；测试里可替换。 */
export interface BridgeSocket {
    write(chunk: Buffer): boolean;
    end(): void;
    destroy(): void;
    on(event: 'data', listener: (chunk: Buffer) => void): unknown;
    on(event: 'end' | 'close' | 'error', listener: () => void): unknown;
}
export interface StdioBridgeOptions {
    /** 往 distro 侧写帧（通常是 `wsl.exe` 子进程的 stdin）。 */
    readonly write: (frame: Buffer) => void;
    /** 连本地凭据代理端口的工厂。 */
    readonly connectProxy: () => BridgeSocket;
    /** 每收到一帧 `TYPE_READY` 时回调（distro 侧监听端口）。 */
    readonly onReady?: (distroPort: number) => void;
    /** 出现无法归属到某条连接的帧时回调，用于结构化告警而不是静默丢。 */
    readonly onStray?: (frame: Frame) => void;
}
/**
 * 宿主侧拼接器。
 *
 * `TYPE_OPEN` 由 distro 侧发起（它接受了一条本 distro 内的连接），宿主据此新建一条到
 * 本地凭据代理的 socket，之后双向搬运字节。**任何方向都不做内容解释** —— 凭据替换
 * 发生在本地代理里，桥只是管子，因此桥本身看不到明文密钥。
 */
export declare class StdioBridge {
    #private;
    constructor(options: StdioBridgeOptions);
    /** distro 侧最近一次通告的监听端口。 */
    distroPort: number | undefined;
    /** 当前仍然活着的逻辑连接数。 */
    get liveConnections(): number;
    /** 喂一段 distro 侧输出。 */
    ingest(chunk: Buffer): void;
    /** 关闭所有逻辑连接；不触碰 distro 侧进程（那是 `dispose` 的职责）。 */
    dispose(): void;
}
//# sourceMappingURL=bridge.d.ts.map