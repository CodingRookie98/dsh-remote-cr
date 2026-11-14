/**
 * WSL 后端的 `RemoteBackend` 实现：把 M1 就有的自由函数（`runInDistro` / `launchRemoteDsh`）
 * 收成接口形态，让上层只认「探测 / 启动 / 回收」三个动词。
 *
 * 为什么现在补这一层：M2 的 SSH 已能跑（S9 真机 7/7），但投影/提示词/工具层仍硬编码
 * `backend: 'wsl'`。要让 SSH 接进去，上头必须有一个**同一形态**的对象可拿到——
 * 否则「按 kind 分派」这件事没地方落脚。
 *
 * 刻意不做的事：
 * - **不探测 mirrored 网络模式**。`wsl --list --verbose` 没有这一列，要判定得去读
 *   `/etc/resolv.conf` 或 `ip route`，那是 env-policy 的活；这里如实给 `undefined`，
 *   不冒充 `false`（`false` 会被上层读成「确认是 NAT 模式」）。
 * - **不管端口是否已释放**。那是 launch 的看门狗与 dispose 的职责，不是后端的。
 */
import type { BackendProbe, LaunchRequest, RemoteBackend } from '../backend.ts';
import type { RemoteDshHandle } from '../handle.ts';
import { type LaunchOptions } from './launch.ts';
/** 单测注入点：`runInDistro` 的窄化签名，只需它真用到的字段。 */
export type RunInDistroLike = (executable: string, distro: string, command: readonly string[], options?: {
    timeoutMs?: number;
}) => Promise<{
    stdoutText: string;
    stderrText: string;
    exitCode: number | null;
}>;
export type LaunchLike = (options: LaunchOptions) => Promise<RemoteDshHandle>;
export interface WslRemoteBackendOptions {
    readonly distro: string;
    /** `wsl.exe` 路径；默认交给 `launch.ts` 的默认值。 */
    readonly executable?: string;
    /** 探测超时，默认 20s：`uname` + `node -v` 在同一台机上通常 100ms 内，留足冷启动余量。 */
    readonly probeTimeoutMs?: number;
    readonly runInDistro?: RunInDistroLike;
    readonly launch?: LaunchLike;
}
export declare class WslRemoteBackend implements RemoteBackend {
    #private;
    readonly kind: "wsl";
    readonly target: string;
    constructor(options: WslRemoteBackendOptions);
    probe(): Promise<BackendProbe>;
    launch(request: LaunchRequest): Promise<RemoteDshHandle>;
    /**
     * 回收自己起的全部句柄。可重复调用：第二次起没有句柄，直接答 `clean: true`。
     *
     * 全有全无地记账：只要有一个句柄说自己不干净，`clean` 就是 false —— 上层据此决定
     * 是否把「退出后仍有残留」报给用户，不能因为别的句柄干净就把它盖过去。
     */
    dispose(): Promise<{
        readonly clean: boolean;
    }>;
}
//# sourceMappingURL=remote-backend.d.ts.map