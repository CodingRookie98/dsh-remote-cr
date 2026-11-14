/**
 * 带 Cookie 的 WebSocket 客户端（宿主半，node 侧）。
 *
 * 为什么不用全局 `WebSocket`：官方 `/api/remote.mux` 的准入只认 `/connect` 下发的
 * v2 签名 Cookie，而 WHATWG `WebSocket` 构造器**没有**设置请求头的入口。T5 探针
 * （`spikes/m1/harness.cjs` 的 `createCookieSocket`）已经用同样的手写实现跑通，
 * 这里把它搬进产品代码并补齐错误路径。
 *
 * 实现的是官方 `ConnectionWebSocket` 契约
 * （`packages/client/connection/src/client/socket.ts:12-31`）：
 * `readyState` / `send` / `close` / `addEventListener` / `removeEventListener`。
 * 也就是说它可以直接喂给 `installConnection` 的 `transport.createWebSocket`。
 *
 * 帧编解码只做客户端必须的那部分：掩码发送、解服务端帧、自动回 pong、close 帧转
 * `close` 事件。**不做压缩协商**——我们不发 `Sec-WebSocket-Extensions`，
 * 服务端也就不会启用 permessage-deflate。
 */
/** 与官方 `ConnectionWebSocket` 对齐的最小接口（不 import 那个包，它是浏览器侧类型）。 */
export interface SocketLike {
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    addEventListener(event: string, listener: (event: never) => void, options?: {
        once?: boolean;
    }): void;
    removeEventListener(event: string, listener: (event: never) => void): void;
}
export type SocketListener = (event: never) => void;
export interface CookieSocketOptions {
    readonly host: string;
    readonly port: number;
    readonly path: string;
    /** `/connect` 下发的 `dsh-auth-*=v2.…`；缺省则不带 Cookie（仅测试用）。 */
    readonly cookie?: string;
    /**
     * 负控专用：故意把期望的 `Sec-WebSocket-Accept` 改错，让握手失败。
     * 生产路径永远不传。
     */
    readonly acceptMismatch?: boolean;
    /** 握手超时，默认 10s；超时按 `error` 事件上报。 */
    readonly handshakeTimeoutMs?: number;
}
/**
 * 把一个文本帧编码成掩码帧（客户端必须掩码，服务端收到未掩码帧会直接断开）。
 * @param text - 已序列化的文本负载
 * @param opcode - 帧类型，默认文本帧
 * @returns 可直接写进 socket 的字节
 */
export declare function encodeClientFrame(text: string, opcode?: number): Buffer;
/** 解出来的一个服务端帧。 */
export interface ServerFrame {
    readonly opcode: number;
    readonly payload: Buffer;
}
/**
 * 增量解帧器：把 `data` 事件里的字节流切成完整帧。
 *
 * 不完整就留着等下一块——TCP 不保证一帧一个 chunk，这是唯一正确的写法。
 * 分片帧（FIN=0）按「拼接后一次性交付」处理：我们只承载 JSON 文本帧，
 * 服务端实际不会分片，但拼起来比直接丢弃安全。
 */
export declare class FrameReader {
    #private;
    /** 喂入一块字节，返回本次能解出的全部完整帧。 */
    push(chunk: Buffer): ServerFrame[];
}
/** 一个已经建立（或正在建立）的带 Cookie 连接。 */
export interface CookieSocket extends SocketLike {
    /** 主动断开并释放底层 socket；重复调用安全。 */
    dispose(): void;
}
/**
 * 建一条带 Cookie 的 WebSocket。
 *
 * 返回对象**立即**可用（`readyState === 0`），`open` 事件在 101 且 Accept 校验通过后触发。
 * 握手被拒（非 101、Accept 不匹配、HTTP 响应而非 upgrade）统一走 `error` 事件，
 * 不抛异常——官方内核只监听事件，抛出来没人接。
 */
export declare function createCookieSocket(options: CookieSocketOptions): CookieSocket;
//# sourceMappingURL=ws.d.ts.map