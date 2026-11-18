/**
 * 宿主半路由的**统一信封**与 HTTP 小工具。
 *
 * 三条纪律（都有单测）：
 * 1. **每条路由都只回 JSON**，成功 `{ ok: true, value }`，失败 `{ ok: false, code, detail, nextActions }`。
 *    浏览器半的 `RemoteCrApiError` 就是照这个形状抛的，形状变了错误就没法分阶段展示。
 * 2. **只答本机回环**。这条隧道是给本地 GUI 用的，局域网里任何人能打它就是越权面
 *    （architecture §10「远端 host 只绑回环」同理）。
 * 3. **body 有上限**。这里所有请求都是小 JSON，超过 64 KiB 只可能是打错了地址。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
/** 请求体上限；与官方 `open-in-app` 的 `MAX_BODY_BYTES` 同值。 */
export declare const MAX_BODY_BYTES: number;
export interface OkEnvelope<T> {
    readonly ok: true;
    readonly value: T;
}
export interface ErrEnvelope {
    readonly ok: false;
    readonly code: string;
    readonly detail: string;
    readonly nextActions: readonly string[];
    /**
     * 可照抄的命令与远端原文。**不能只放 nextActions**：客户端会把 nextActions 换成本地化字典文案，
     * 精确命令（含 staging 路径）与 npm 原文只有这两个字段能原样带到浏览器（R1 BLK-4）。
     */
    readonly command?: string;
    readonly logTail?: string;
}
export type Envelope<T> = OkEnvelope<T> | ErrEnvelope;
export declare function okEnvelope<T>(value: T): OkEnvelope<T>;
/**
 * 把任意抛出物转成信封。
 *
 * `RemoteCrError` 原样透出四个字段（码/说明/下一步都在里面）；其它异常统一归到
 * `remote/unknown`——**不把内部栈或绝对路径回给浏览器**，但也不吞掉，detail 里
 * 至少有一句可读的原因。
 */
export declare function errorEnvelope(error: unknown): ErrEnvelope;
/** 只放行本机回环（含 IPv4-mapped）。 */
export declare function isLoopbackRequest(req: Pick<IncomingMessage, 'socket'>): boolean;
/** 写一条 JSON 响应。`no-store`：这些数据随时会变，缓存只会显示过期状态。 */
export declare function sendJson(res: ServerResponse, status: number, body: unknown): void;
export declare function sendMethodNotAllowed(res: ServerResponse, allowed: readonly string[]): void;
/**
 * 读完并解析请求体。
 *
 * 超限立刻 413 并 `destroy()`：继续读下去就是把内存交给对方。
 */
export declare function readJsonBody(req: IncomingMessage): Promise<unknown>;
//# sourceMappingURL=envelope.d.ts.map