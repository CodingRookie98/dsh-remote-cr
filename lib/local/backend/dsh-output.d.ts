/**
 * 远端 `dsh` 的**纯解析**层：从日志里认出「它起来了」还是「它为什么没起来」。
 *
 * 这一层不 spawn、不 sleep，只做文本 → 结构化事实，所以能在任何机器上单测。
 * 所有正则的根据都来自真机日志（原文见 `spikes/m1/p32-launch/README.md`）：
 *
 * - 成功：`dsh web: http://127.0.0.1:8899/?token=<token>`
 * - 端口占用：`Error: listen EADDRINUSE: address already in use 127.0.0.1:8899`
 *   （外层还有 `dsh: startup failed: 2 required plugins did not activate`）
 * - 无 node：`nohup: failed to run command 'node': No such file or directory`
 */
import { RemoteCrError } from './errors.ts';
import type { DshEndpoint } from './handle.ts';
export type { DshEndpoint };
/**
 * 从日志全文里找 dsh 自己打印的访问 URL。
 * 找不到返回 `undefined` —— 调用方据此判定「还在启动」或「启动失败」，不猜。
 */
export declare function parseDshEndpoint(logText: string): DshEndpoint | undefined;
/** 取日志最后 `lines` 行，供「复制日志」使用。 */
export declare function tailLines(logText: string, lines?: number): string;
export interface StartFailureFacts {
    readonly portInUse?: {
        host: string;
        port: number;
    };
    readonly missingCommand?: string;
    readonly startupFailed?: string;
}
/** 把失败日志拆成可判定的结构化事实；认不出的部分留空，不臆造。 */
export declare function readStartFailure(logText: string): StartFailureFacts;
/**
 * 启动失败的分类：把日志事实翻成**用户能照着做**的结构化错误。
 *
 * 顺序有讲究——先判最具体的原因（端口占用、缺 node），再落到泛化的 startup-failed，
 * 否则所有失败都会被「2 required plugins did not activate」这层包装吞掉，用户拿不到
 * 「是端口被占了」这种能立刻动手的信息（铁律 4「失败要响」）。
 */
export declare function classifyStartFailure(logText: string): RemoteCrError;
//# sourceMappingURL=dsh-output.d.ts.map