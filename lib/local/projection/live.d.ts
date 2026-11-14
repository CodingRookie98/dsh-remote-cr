/**
 * 真机实现：把「连到一台远端」接成 `ProjectionService` 需要的那一个函数。
 *
 * 顺序不能换：
 * 1. 起远端 `dsh web` 并从日志里取 `token`；
 * 2. `RemoteRpc.open` 用 `token` 换 v2 签名 Cookie 并建 RPC 驱动。
 *
 * 两条后端各走各的启动器，**共用同一段收尾**（`openConnection`）：
 * - WSL：`launchRemoteDsh`（`wsl.exe --exec`，真机 9–18s）；
 * - SSH：`launchSshDsh`（`ssh -L` 隧道 + 远端看门狗，真机 66s 冷启动 / 16s 热）；
 * 两边的 `handle.endpoint` 都已是**本地可连**的 `{host, port, token}`（SSH 的端口是
 * 本地隧道口，不是远端的 8899），所以握手代码不需要知道后端是谁。
 *
 * 为什么 launch 与 handshake 必须成对：token 只出现在**这一次启动的日志**里
 * （`parseDshEndpoint`）。拿着上一次的 token 去握手只会得 401，所以这里不接受
 * 外部传入的 token —— 连接的所有权必须和进程的所有权在一起。
 *
 * **进程与传输是分开释放的**（P3.5.2 实测后改）：
 * - `rehandshake()` 只换传输，进程留着 —— 真机实测 5ms；
 * - `dispose()` 连进程一起收 —— 重新起进程要 9.2s（WSL）/ 66s（SSH 冷启动）。
 * 断线时先试前者：远端没死就白拿一段冷启动。绝不能反过来（先重启再判断），那等于
 * 每次抖动都让用户等一次冷启动。
 *
 * 释放时**先放 RPC 再收进程**：反过来会让还活着的 WS 撞上一个已经消失的宿主，
 * 日志里出现一堆无意义的 ECONNRESET。
 */
import { TeleportError } from '../backend/errors.ts';
import { type SshTarget } from '../backend/ssh/config.ts';
import { type RemoteDshRuntime, type ResolveRemoteDshRequest } from '../backend/ssh/runtime.ts';
import { type SshAuth } from '../backend/ssh/transport.ts';
import type { AttachControl, ConnectTarget, RemoteConnection } from './service.ts';
/** SSH 后端需要的宿主侧材料；不给就明确报错，不猜默认值。 */
export interface LiveSshOptions {
    /** 本地 home：`~/.ssh/config` 与 `.dsh-teleport/`（known_hosts、anchors）都挂在这里。 */
    readonly homeDir: string;
    /**
     * 按别名解析认证方式。
     *
     * 为什么是回调而不是字段：口令/私钥口令只在**真的要连**的时候才该出现，
     * 而且要能走系统的凭据存储（`git credential` / Windows Credential Manager），
     * 那些来源是异步且可能弹窗的。这里只要求「给我一台目标的认证方式」。
     */
    readonly authFor: (target: SshTarget) => SshAuth | Promise<SshAuth>;
    /** 覆盖 `~/.ssh/config` 的位置（探针与多份配置的测试用）。 */
    readonly configFile?: string;
    readonly sshExecutable?: string;
    readonly connectTimeoutMs?: number;
    /**
     * 本机凭据代理端口：给了就在 `ssh` 上加 `-R 127.0.0.1:0:127.0.0.1:<port>`。
     *
     * 为什么是可选：代理起不来（没有凭据文件、端口被占）不该让整个远端连不上 ——
     * 那种情况下用户仍能连远端、只是模型请求不走代理。但**失败要响**：代理起不来时
     * 入口会记一条日志，而不是静默当成没配。
     */
    readonly proxyPort?: number | (() => number | undefined);
    /**
     * 追加给远端 dsh 进程的环境变量（值里可用 `$TELEPORT_PROXY_URL`）。
     *
     * 为什么入口要能传：远端 provider 的 `baseURL`/key 只能靠环境变量在启动时指定，
     * 而代理的远端端口是转发建好之后才分配 —— 调用方在启动前不知道它，
     * 所以这里只传「怎么引用」，展开交给 `buildRemoteLaunchScript`。
     */
    readonly extraEnv?: Readonly<Record<string, string>>;
    /** 装哪个版本的 dsh（只有走到引导器时用得上）。 */
    readonly dshVersion?: string;
    /**
     * 「远端 dsh 用哪一份」的注入缝：缺省走 `resolveRemoteDsh`（检出优先，否则引导器装 staging）。
     *
     * 留这个缝不是为了测试方便而已：真机上「远端有没有检出」是环境事实，
     * 而这里要能在没有 SSH 的机器上被完整单测。
     */
    readonly resolveDsh?: (request: ResolveRemoteDshRequest) => Promise<RemoteDshRuntime>;
}
export interface LiveConnectOptions {
    /** `wsl.exe` 可执行文件名或绝对路径。 */
    readonly executable?: string;
    /** 起远端 dsh 的超时，默认 60s（WSL 真机实测 9–18s）。 */
    readonly launchTimeoutMs?: number;
    /** SSH 后端材料；没配就只支持 WSL 目标（点 SSH 会得到结构化错误）。 */
    readonly ssh?: LiveSshOptions;
    /**
     * 环境档位（`reuse` / `isolated` / `sync`）。缺省 `reuse`。
     *
     * 收**原始字符串**而不是解析后的值：档位来自配置/环境变量，写错时必须让用户
     * 在「点连接」那一刻看到结构化错误，而不是插件加载时就崩掉、连面板都开不出来。
     */
    readonly envPolicy?: string | undefined;
}
/**
 * 造一个「给定 target 就连上去」的函数。
 *
 * 返回的函数**每次都真的起一个远端进程**：`ProjectionService` 已经保证同一 target
 * 不重复调用它，所以这里不需要自己做缓存。断线重连优先走 `rehandshake()`，
 * 只有进程真的没了才会再进这里。
 */
export declare function createLiveConnect(options?: LiveConnectOptions): (target: ConnectTarget, control?: AttachControl) => Promise<RemoteConnection>;
/** 只用于日志与错误说明的一行摘要；**不含**主机名与用户名。 */
export declare function describeTarget(target: ConnectTarget): string;
/**
 * 从 `/attach` 的请求体里读出 target。
 *
 * `backend` 缺省为 `wsl`：P3.5 的探针与既有客户端都不带这个字段，缺省让它们照旧；
 * 显式写 `ssh` 才要求 `alias`，不会把空 `distro` 当成 SSH。
 */
export declare function readTarget(body: unknown): ConnectTarget;
/** 传输层已经没了、但连接对象仍被持有时，读写 `rpc` 的兜底错误。 */
export declare function detachedError(): TeleportError;
//# sourceMappingURL=live.d.ts.map