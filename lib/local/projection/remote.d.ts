/**
 * 远端 dsh 的 RPC 驱动（宿主半）。
 *
 * 这是 C 型（ADR-0003）在**产品代码**里的那一半：本地进程用官方线上协议直连远端
 * `dsh web`，拿工作区、建会话、开逻辑流。协议细节不在这里发明——全部照
 * `packages/api/gateway/src/stream-protocol.ts` 与
 * `packages/client/connection/src/client/rpc.ts:37-70` 的既有形状：
 *
 * - 一元调用：`POST /api/<endpoint>`，请求体 `{type:'client-request', rpcId, method, payload}`，
 *   响应体 `{type:'server-response', rpcId, result:{ok:true,value}|{ok:false,error}}`；
 * - 逻辑流：`WS /api/remote.mux`，先发 `{type:'open',streamId,endpoint,payload}`，
 *   之后收 `item` / `error` / `end`；上行用 `{type:'item',streamId,value}`。
 *
 * **为什么自己写而不用官方 `installConnection`**：那个入口装在浏览器侧的 client 上下文里，
 * 而宿主半要做的是「在会话建立前就把远端事实读出来」（投影、断言、失败分类）。
 * 官方内核的 `installConnection` 在 T5 已证明可用，浏览器半将来照用；宿主半这条
 * 走同一套线上字节，只是不带那一层 UI 语义。
 *
 * 准入：`/connect` 换 v2 签名 Cookie，之后每个 HTTP 请求与 WS 握手都要带它。
 *
 * **一条 WS 只能配一张自己的 cookie**（P3.5.2 真机定论，不是保守写法）：
 * 官方 `REMOTE_STREAM_MUX_PATH` 的 upgrade handler 在 socket `close` 时调
 * `admission.release()`（`packages/api/gateway/src/index.ts:264-301`），而 release 会
 * **同步 `peers.delete(peer.id)`**（`packages/client/connection/src/rpc-host.ts:145-162`）；
 * `admit()`（同文件 :129-137）查不到 peer 就回 `{rejection:401}`。
 * 后果是**关一条流，就把同一 cookie 之后所有调用打成 401**。
 * 所以 `openStream` 为每条流单独握手换 cookie（实测 5ms），而不是复用一条。
 */
/** 远端 `dsh web` 的地址。 */
export interface RemoteEndpoint {
    readonly host: string;
    readonly port: number;
}
/** `/connect` 的结果。 */
export interface RemoteHandshake {
    readonly cookie: string;
    readonly location: string;
}
/** 线上响应里的一元结果。 */
export type RemoteResult<T> = {
    readonly ok: true;
    readonly value: T;
} | {
    readonly ok: false;
    readonly error: {
        readonly code: string;
        readonly message: string;
    };
};
/**
 * 投影层需要的**最小 RPC 面**。
 *
 * 只声明这两个方法，是为了让投影编排器能在单测里用假件驱动：真的 `RemoteRpc`
 * 满足它，一个只记录调用参数的桩也满足它。声明成接口而不是直接依赖 `RemoteRpc`
 * 类，另一个好处是 P3.5.1 的重连实现可以换一个「每次调用重新握手」的驱动，
 * 而投影编排器一个字都不用改。
 */
export interface ProjectionRpc {
    call<T>(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<T>;
    openStream(endpoint: string, payload: unknown, uplink?: AsyncIterable<unknown>): StreamHandle;
}
/**
 * 一条逻辑流的句柄。
 *
 * 除了可迭代，还必须能**从消费侧叫停**：调用方（取证、将来的重连快照）在超时或
 * 取消时要能立刻收手，而不是干等下一帧。没有 `cancel()` 的话，消费侧只能
 * `iterator.return()`，而生成器正停在 `await` 上等下一帧 —— 那个 `return()`
 * 会一直排队不结算（真机上就是 P3.5 探针卡死 20 分钟的那次）。
 */
export interface StreamHandle extends AsyncIterable<StreamEvent> {
    cancel(): void;
}
/** 一次逻辑流事件。 */
export type StreamEvent = {
    readonly type: 'item';
    readonly value: unknown;
} | {
    readonly type: 'end';
} | {
    readonly type: 'error';
    readonly code: string;
    readonly message: string;
};
export interface RemoteRpcOptions {
    /** 握手超时，默认 15s。 */
    readonly handshakeTimeoutMs?: number;
    /** 一元调用超时，默认 30s。 */
    readonly callTimeoutMs?: number;
    /** 注入以便单测；默认用全局 `fetch`。 */
    readonly fetchImpl?: typeof fetch;
    /**
     * 取消信号：握手也必须能被打断。
     *
     * 没有它，「点取消」最坏要等握手 15s 才被看见 —— 那正是「点了没反应」的来源之一
     * （R1 #2 B-1 同族）。
     */
    readonly signal?: AbortSignal;
}
/**
 * `/connect?token=…` 换 Cookie。
 *
 * 失败一律结构化：401/403 是 token 不对（要重新从远端日志取 token），其它状态码
 * 归 `remote/unknown` 并带上状态码——铁律 4 要求「失败要响」，这里不给静默兜底。
 */
export declare function handshakeRemote(endpoint: RemoteEndpoint, token: string, options?: RemoteRpcOptions): Promise<RemoteHandshake>;
/**
 * 一个已握手的远端连接。
 *
 * 生命周期：`open` → 若干 `call` / `openStream` → `dispose`。
 * 不做自动重连：重连策略在 `shared/reconnect.ts` 的状态机里，这里只管一次连接。
 */
export declare class RemoteRpc {
    #private;
    private constructor();
    /** 握手并返回驱动。 */
    static open(endpoint: RemoteEndpoint, token: string, options?: RemoteRpcOptions): Promise<RemoteRpc>;
    get cookie(): string;
    get endpoint(): RemoteEndpoint;
    /**
     * 一次一元 RPC。
     *
     * `payload` 直接是线上 payload（调用方自己包 `{args:{…}}`），因为不同端点的
     * 参数名不同（`request` / `_request` / 平铺），在这里猜名字只会制造隐藏耦合。
     */
    call<T>(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<T>;
    /**
     * 开一条逻辑流，按 `StreamEvent` 逐个产出。
     *
     * `uplink` 可选：给 `terminal/attach` 这类双向流喂输入。每次调用都**新开一条 WS**
     * （一条 cookie 只能拥一条 WS，见文件头），流结束时关掉它。
     *
     * 返回**句柄而不是裸生成器**：消费侧要能在超时或取消时立刻收手。裸生成器只能
     * `iterator.return()`，而生成器正停在「等下一帧」的 `await` 上时，那个 `return()`
     * 会一直排队不结算 —— 真机上就是 P3.5 探针卡死二十几分钟的那次。
     * `cancel()` 直接往收件箱塞一个 `end` 把等待者唤醒，再把 socket 关掉。
     */
    openStream(endpoint: string, payload: unknown, uplink?: AsyncIterable<unknown>): StreamHandle;
    /** 关掉本驱动持有的全部 WS。 */
    dispose(): void;
}
/** 校验一元响应信封；rpcId 对不上说明响应串了，必须报错而不是猜。 */
/** 远端拒绝 → 本地错误码。映射规则集中一处，改映射表时只动这里。 */
export declare function rejectionCode(code: string): string;
/** 把远端的错误码折成能挂在本地 `remote/<x>` 上的片段；空串表示远端没给码。 */
export declare function slugOf(code: string): string;
export declare function readResult(envelope: unknown, endpoint: string, rpcId: string): RemoteResult<unknown>;
/** 解析一条 mux 帧；不属于本流的帧返回 undefined（同一条 WS 上可能有别的流）。 */
export declare function parseStreamFrame(raw: unknown, streamId: string): StreamEvent | undefined;
//# sourceMappingURL=remote.d.ts.map