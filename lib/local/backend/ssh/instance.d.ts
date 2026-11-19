export declare const INSTANCE_VERSION = 1;
export declare const INSTANCE_DIR = ".dsh-remote-cr/instances";
export declare const DEFAULT_INSTANCE_TTL_MS: number;
export interface RemoteInstance {
    readonly version: number;
    readonly pid: number;
    readonly port: number;
    readonly token: string;
    readonly startedAt: string;
    readonly argvPrefix: string;
}
/** 登记文件的远端绝对路径（基于远端 `$HOME`，不是本地 home）。 */
export declare function instancePath(remoteHome: string, anchorId: string): string;
/** 写登记文件：先建目录，再原子写（临时文件 + mv），避免读到半个 JSON。 */
export declare function buildWriteInstanceScript(path: string, instance: RemoteInstance): string;
/** 读登记文件 + 顺带报告端口是否在监听（一次往返拿两件事）。 */
export declare function buildReadInstanceScript(path: string, port: number): string;
/** 从「INSTANCE=<json>」+ ss 输出里解析出实例与端口状态。半截 JSON / 版本不认都返回 null。 */
export declare function parseInstanceOutput(stdout: string, expectedPort: number): {
    instance: RemoteInstance;
    portListening: boolean;
} | null;
/** 实例是否已超 TTL（无重连的驻留实例要能被下一个接入者回收）。 */
export declare function isInstanceExpired(instance: RemoteInstance, nowMs: number, ttlMs?: number): boolean;
/** 回收一个驻留实例（只 kill pid；不删登记文件，留给诊断）。 */
export declare function buildKillInstanceScript(pid: number): string;
/**
 * 杀完之后**确认 pid 真的没了**：`kill -9` 返回 0 只说明信号发出去了。
 * 打 `PID_GONE` / `PID_ALIVE` 两种标记，调用方据此决定要不要报 `remote/recycle-incomplete`（P4 P2-3）。
 */
export declare function buildKillAndVerifyScript(pid: number): string;
//# sourceMappingURL=instance.d.ts.map