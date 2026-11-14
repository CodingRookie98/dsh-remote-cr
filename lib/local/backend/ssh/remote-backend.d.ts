/**
 * SSH 后端的 `RemoteBackend` 实现：把 S3–S9 攒下的自由函数收成接口形态。
 *
 * 与 WSL 版的差别只有三处，且都在实现里：
 * - 探测走 `probeSshTarget`（**首次接触就是 TOFU 发生的地方**，所以必须走 `connectRemote`）；
 * - 启动要 `target/auth/homeDir`（连接参数不是「一个发行版名」能表达的）；
 * - `dispose()` 收的是 `SshRemoteHandle`，它比中立的句柄多 `localPort` 等字段，
 *   但回收语义一样：只碰自己起的那个进程树。
 *
 * 刻意不做的事：**不在这里 bootstrap**。装包/上传是 `S9` 引导器的职责，后端只负责
 * 「在一个已经能跑 dsh 的目标上把它拉起来」；把安装混进来会让 probe 与 launch 的成功
 * 条件纠缠（装了但没装对，究竟算探测失败还是启动失败说不清）。
 */
import type { BackendProbe, LaunchRequest, RemoteBackend } from '../backend.ts';
import type { RemoteDshHandle } from '../handle.ts';
import type { SshTarget } from './config.ts';
import { type SshProbeRequest, type SshProbeResult } from './probe.ts';
import { type SshLaunchOptions, type SshRemoteHandle } from './launch.ts';
import type { SshAuth } from './transport.ts';
export type ProbeLike = (request: SshProbeRequest) => Promise<SshProbeResult>;
export type SshLaunchLike = (options: SshLaunchOptions) => Promise<SshRemoteHandle>;
export interface SshRemoteBackendOptions {
    /** 本地 home，用于展开 `~` 与 known_hosts 账本位置。 */
    readonly homeDir: string;
    readonly target: SshTarget;
    readonly auth: SshAuth;
    /** 远端监听端口；不给就交给 `launchSshDsh` 的默认值（8899）。 */
    readonly remotePort?: number;
    /** 本地隧道口；不给就让内核挑。 */
    readonly localPort?: number;
    /** 本地凭据代理端口；给了才挂 `-R`。 */
    readonly proxyPort?: number;
    readonly sshExecutable?: string;
    readonly askpassPath?: string;
    /** 探测超时，默认 30s：SSH 握手 + 一次远端 sh 比 WSL 慢。 */
    readonly probeTimeoutMs?: number;
    /** 单测注入点。 */
    readonly probe?: ProbeLike;
    readonly launch?: SshLaunchLike;
}
export declare class SshRemoteBackend implements RemoteBackend {
    #private;
    readonly kind: "ssh";
    readonly target: string;
    constructor(options: SshRemoteBackendOptions);
    probe(): Promise<BackendProbe>;
    launch(request: LaunchRequest): Promise<RemoteDshHandle>;
    /** 回收自己起的全部句柄；可重复调用。任一不干净 ⇒ `clean: false`。 */
    dispose(): Promise<{
        readonly clean: boolean;
    }>;
}
//# sourceMappingURL=remote-backend.d.ts.map